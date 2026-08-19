import { db } from "../../database/client.js";
import type { DomainEvent, EventBus } from "../../core/event-bus.js";
import { createGoogleCalendarEvent, syncGoogleCalendarAccount } from "../connectors/google-calendar/sync.js";

export interface ExecutiveProposal {
  id: string;
  householdId: string;
  ownerMemberId?: string;
  kind: "task" | "event" | "commitment" | "deadline" | "information";
  status: "pending" | "approved" | "rejected" | "executing" | "executed" | "failed";
  title: string;
  summary?: string;
  startsAt?: string;
  dueAt?: string;
  confidence: number;
  payload: Record<string, unknown>;
  targetSourceAccountId?: string;
  targetGoogleCalendarId?: string;
  error?: string;
  createdAt: string;
}

interface CandidateForProposal {
  id: string;
  household_id: string;
  owner_member_id: string | null;
  source_item_id: string;
  kind: ExecutiveProposal["kind"] | "none" | "unknown";
  confidence: number | null;
  extracted: Record<string, unknown> | null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function proposalKind(candidate: CandidateForProposal): ExecutiveProposal["kind"] | null {
  if (["task", "event", "commitment", "deadline", "information"].includes(candidate.kind)) {
    return candidate.kind as ExecutiveProposal["kind"];
  }
  return null;
}

async function createProposalFromCandidate(candidateId: string): Promise<void> {
  const result = await db.query<CandidateForProposal>(
    `SELECT id, household_id, owner_member_id, source_item_id,
            kind::text, confidence, extracted
     FROM extraction_candidates
     WHERE id = $1 AND status = 'analyzed'`,
    [candidateId],
  );
  const candidate = result.rows[0];
  if (!candidate || !candidate.extracted) return;
  const kind = proposalKind(candidate);
  if (!kind || kind === "information" || (candidate.confidence ?? 0) < 0.55) return;

  const extracted = candidate.extracted;
  const title =
    typeof extracted.title === "string" && extracted.title.trim()
      ? extracted.title.trim().slice(0, 240)
      : "Pendiente detectado por SOL";
  const summary =
    typeof extracted.summary === "string" && extracted.summary.trim()
      ? extracted.summary.trim().slice(0, 2000)
      : null;
  const startsAt = parseDate(extracted.dateTime);
  const dueAt = parseDate(extracted.dueAt);
  const visibility = candidate.owner_member_id ? "private" : "family";

  await db.query(
    `INSERT INTO executive_proposals(
       household_id, owner_member_id, source_candidate_id, source_item_id,
       kind, title, summary, starts_at, due_at, visibility, confidence, payload
     ) VALUES ($1, $2, $3, $4, $5::executive_proposal_kind, $6, $7, $8, $9,
               $10::visibility_scope, $11, $12::jsonb)
     ON CONFLICT(source_candidate_id) DO NOTHING`,
    [
      candidate.household_id,
      candidate.owner_member_id,
      candidate.id,
      candidate.source_item_id,
      kind,
      title,
      summary,
      startsAt,
      dueAt,
      visibility,
      candidate.confidence ?? 0,
      JSON.stringify(extracted),
    ],
  );
}

export function registerExecutiveProposalProcessor(eventBus: EventBus): () => void {
  return eventBus.subscribe<{ candidateId?: string }>(
    "extraction.completed",
    async (event: DomainEvent<{ candidateId?: string }>) => {
      if (event.payload.candidateId) await createProposalFromCandidate(event.payload.candidateId);
    },
  );
}

export async function listExecutiveProposals(input: {
  householdId: string;
  memberId: string;
  status?: string;
}): Promise<ExecutiveProposal[]> {
  const result = await db.query<{
    id: string;
    household_id: string;
    owner_member_id: string | null;
    kind: ExecutiveProposal["kind"];
    status: ExecutiveProposal["status"];
    title: string;
    summary: string | null;
    starts_at: Date | null;
    due_at: Date | null;
    confidence: number;
    payload: Record<string, unknown>;
    target_source_account_id: string | null;
    target_google_calendar_id: string | null;
    error: string | null;
    created_at: Date;
  }>(
    `SELECT id, household_id, owner_member_id, kind::text, status::text, title,
            summary, starts_at, due_at, confidence, payload,
            target_source_account_id, target_google_calendar_id, error, created_at
     FROM executive_proposals
     WHERE household_id = $1
       AND (owner_member_id = $2 OR owner_member_id IS NULL)
       AND ($3::text IS NULL OR status::text = $3)
     ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,
              COALESCE(starts_at, due_at, created_at) ASC`,
    [input.householdId, input.memberId, input.status ?? null],
  );
  return result.rows.map((row) => ({
    id: row.id,
    householdId: row.household_id,
    ownerMemberId: row.owner_member_id ?? undefined,
    kind: row.kind,
    status: row.status,
    title: row.title,
    summary: row.summary ?? undefined,
    startsAt: row.starts_at?.toISOString(),
    dueAt: row.due_at?.toISOString(),
    confidence: row.confidence,
    payload: row.payload,
    targetSourceAccountId: row.target_source_account_id ?? undefined,
    targetGoogleCalendarId: row.target_google_calendar_id ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at.toISOString(),
  }));
}

async function chooseCalendarTarget(
  householdId: string,
  ownerMemberId: string | null,
): Promise<{ sourceAccountId: string; googleCalendarId: string } | null> {
  const result = await db.query<{ source_account_id: string; id: string }>(
    `SELECT gc.source_account_id, gc.id
     FROM google_calendars gc
     JOIN source_accounts sa ON sa.id = gc.source_account_id
     WHERE sa.household_id = $1
       AND sa.provider = 'google_calendar'
       AND sa.status = 'connected'
       AND gc.selected_for_write = true
       AND gc.access_role IN ('writer', 'writerWithoutPrivateAccess', 'owner')
       AND (($2::uuid IS NOT NULL AND sa.owner_member_id = $2)
            OR ($2::uuid IS NULL AND sa.owner_member_id IS NULL))
     ORDER BY gc.is_primary DESC, gc.updated_at ASC
     LIMIT 1`,
    [householdId, ownerMemberId],
  );
  const row = result.rows[0];
  return row ? { sourceAccountId: row.source_account_id, googleCalendarId: row.id } : null;
}

async function validateExplicitTarget(
  householdId: string,
  ownerMemberId: string | null,
  sourceAccountId: string,
  googleCalendarId: string,
): Promise<void> {
  const result = await db.query(
    `SELECT 1
     FROM google_calendars gc
     JOIN source_accounts sa ON sa.id = gc.source_account_id
     WHERE sa.household_id = $1
       AND sa.id = $2
       AND gc.id = $3
       AND gc.selected_for_write = true
       AND gc.access_role IN ('writer', 'writerWithoutPrivateAccess', 'owner')
       AND (($4::uuid IS NOT NULL AND sa.owner_member_id = $4)
            OR ($4::uuid IS NULL AND sa.owner_member_id IS NULL))`,
    [householdId, sourceAccountId, googleCalendarId, ownerMemberId],
  );
  if (!result.rowCount) throw new Error("calendar_target_not_allowed");
}

export async function rejectExecutiveProposal(input: {
  proposalId: string;
  householdId: string;
  memberId: string;
}): Promise<boolean> {
  const result = await db.query(
    `UPDATE executive_proposals
     SET status = 'rejected', decided_by_member_id = $3, decided_at = now(), updated_at = now()
     WHERE id = $1 AND household_id = $2 AND status = 'pending'
       AND (owner_member_id = $3 OR owner_member_id IS NULL)`,
    [input.proposalId, input.householdId, input.memberId],
  );
  return Boolean(result.rowCount);
}

export async function approveExecutiveProposal(input: {
  proposalId: string;
  householdId: string;
  memberId: string;
  targetSourceAccountId?: string;
  targetGoogleCalendarId?: string;
}): Promise<{ kind: "task" | "calendar_event"; id: string; externalEventId?: string }> {
  const client = await db.connect();
  let proposal: {
    id: string;
    owner_member_id: string | null;
    source_item_id: string | null;
    kind: ExecutiveProposal["kind"];
    title: string;
    summary: string | null;
    starts_at: Date | null;
    due_at: Date | null;
    visibility: string;
    confidence: number;
  } | undefined;

  try {
    await client.query("BEGIN");
    const result = await client.query<typeof proposal extends infer _ ? {
      id: string; owner_member_id: string | null; source_item_id: string | null;
      kind: ExecutiveProposal["kind"]; title: string; summary: string | null;
      starts_at: Date | null; due_at: Date | null; visibility: string; confidence: number;
    } : never>(
      `SELECT id, owner_member_id, source_item_id, kind::text, title, summary,
              starts_at, due_at, visibility::text, confidence
       FROM executive_proposals
       WHERE id = $1 AND household_id = $2 AND status = 'pending'
         AND (owner_member_id = $3 OR owner_member_id IS NULL)
       FOR UPDATE`,
      [input.proposalId, input.householdId, input.memberId],
    );
    proposal = result.rows[0];
    if (!proposal) throw new Error("proposal_not_found_or_not_approvable");
    await client.query(
      `UPDATE executive_proposals
       SET status = 'approved', decided_by_member_id = $2, decided_at = now(), updated_at = now()
       WHERE id = $1`,
      [proposal.id, input.memberId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const eventLike = proposal.kind === "event" || (proposal.kind === "commitment" && proposal.starts_at);
  if (!eventLike) {
    const task = await db.query<{ id: string }>(
      `INSERT INTO tasks(
         household_id, owner_member_id, assigned_member_id, title, description,
         status, visibility, confidence, due_at
       ) VALUES ($1, $2, $2, $3, $4, 'open', $5::visibility_scope, $6, $7)
       RETURNING id`,
      [
        input.householdId,
        proposal.owner_member_id,
        proposal.title,
        proposal.summary,
        proposal.visibility,
        proposal.confidence,
        proposal.due_at ?? proposal.starts_at,
      ],
    );
    const taskId = task.rows[0]?.id;
    if (!taskId) throw new Error("task_creation_failed");
    if (proposal.source_item_id) {
      await db.query(
        `INSERT INTO source_links(source_item_id, target_type, target_id, relation)
         VALUES ($1, 'task', $2, 'derived_from')
         ON CONFLICT(source_item_id, target_type, target_id, relation) DO NOTHING`,
        [proposal.source_item_id, taskId],
      );
    }
    await db.query(
      `UPDATE executive_proposals SET status = 'executed', executed_at = now(), updated_at = now() WHERE id = $1`,
      [proposal.id],
    );
    await db.query(
      `INSERT INTO action_log(household_id, actor_member_id, action_type, target_provider, target_ref, approval_state, request, result, completed_at)
       VALUES ($1, $2, 'task.create', 'sol', $3, 'approved', $4::jsonb, $5::jsonb, now())`,
      [input.householdId, input.memberId, taskId, JSON.stringify({ proposalId: proposal.id }), JSON.stringify({ taskId })],
    );
    return { kind: "task", id: taskId };
  }

  if (!proposal.starts_at) {
    await db.query(
      `UPDATE executive_proposals SET status = 'pending', error = 'event_time_required', updated_at = now() WHERE id = $1`,
      [proposal.id],
    );
    throw new Error("event_time_required");
  }

  let target =
    input.targetSourceAccountId && input.targetGoogleCalendarId
      ? { sourceAccountId: input.targetSourceAccountId, googleCalendarId: input.targetGoogleCalendarId }
      : await chooseCalendarTarget(input.householdId, proposal.owner_member_id);
  if (!target) {
    await db.query(
      `UPDATE executive_proposals SET status = 'pending', error = 'calendar_target_required', updated_at = now() WHERE id = $1`,
      [proposal.id],
    );
    throw new Error("calendar_target_required");
  }
  await validateExplicitTarget(
    input.householdId,
    proposal.owner_member_id,
    target.sourceAccountId,
    target.googleCalendarId,
  );

  await db.query(
    `UPDATE executive_proposals
     SET status = 'executing', target_source_account_id = $2,
         target_google_calendar_id = $3, error = NULL, updated_at = now()
     WHERE id = $1`,
    [proposal.id, target.sourceAccountId, target.googleCalendarId],
  );

  try {
    const created = await createGoogleCalendarEvent({
      sourceAccountId: target.sourceAccountId,
      googleCalendarId: target.googleCalendarId,
      proposalId: proposal.id,
      title: proposal.title,
      description: proposal.summary ?? undefined,
      startsAt: proposal.starts_at,
    });
    await db.query(
      `UPDATE executive_proposals SET status = 'executed', executed_at = now(), error = NULL, updated_at = now() WHERE id = $1`,
      [proposal.id],
    );
    await db.query(
      `INSERT INTO action_log(household_id, actor_member_id, action_type, target_provider, target_ref, approval_state, request, result, completed_at)
       VALUES ($1, $2, 'calendar.event.create', 'google_calendar', $3, 'approved', $4::jsonb, $5::jsonb, now())`,
      [
        input.householdId,
        input.memberId,
        created.eventId,
        JSON.stringify({ proposalId: proposal.id, ...target }),
        JSON.stringify(created),
      ],
    );
    void syncGoogleCalendarAccount(target.sourceAccountId).catch((error) =>
      console.error(`[calendar:${target!.sourceAccountId}] post-action sync failed`, error),
    );
    return { kind: "calendar_event", id: proposal.id, externalEventId: created.eventId };
  } catch (error) {
    await db.query(
      `UPDATE executive_proposals SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
      [proposal.id, error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000)],
    );
    throw error;
  }
}
