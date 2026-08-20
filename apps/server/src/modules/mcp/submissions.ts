import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { db } from "../../database/client.js";
import type { AuthPrincipal } from "../auth/session.js";

export type McpSubmissionVisibility = "private" | "family";
export type ScheduleDay =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export interface McpScheduleEntry {
  day: ScheduleDay;
  start: string;
  end?: string;
  title: string;
  location?: string;
  notes?: string;
}

export interface McpScheduleSubmission {
  person: string;
  scheduleName: string;
  timezone?: string;
  validFrom?: string;
  validUntil?: string;
  replaceExisting: boolean;
  entries: McpScheduleEntry[];
}

const DAYS = new Set<ScheduleDay>([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} is required`);
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.length > max) throw new Error(`${field} must be between 1 and ${max} characters`);
  return text;
}

function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

function visibility(value: unknown): McpSubmissionVisibility {
  return value === "family" ? "family" : "private";
}

function validateDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !DATE_RE.test(value)) throw new Error(`${field} must use YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} is not a valid date`);
  }
  return value;
}

export function normalizeScheduleSubmission(input: {
  person?: unknown;
  scheduleName?: unknown;
  timezone?: unknown;
  validFrom?: unknown;
  validUntil?: unknown;
  replaceExisting?: unknown;
  entries?: unknown;
}): McpScheduleSubmission {
  const person = cleanText(input.person, "person", 180);
  const scheduleName = optionalText(input.scheduleName, 120) ?? "Horario";
  const timezone = optionalText(input.timezone, 100);
  const validFrom = validateDate(input.validFrom, "validFrom");
  const validUntil = validateDate(input.validUntil, "validUntil");
  if (validFrom && validUntil && validUntil < validFrom) {
    throw new Error("validUntil must not be before validFrom");
  }
  if (!Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > 80) {
    throw new Error("entries must contain between 1 and 80 schedule entries");
  }
  const entries = input.entries.map((raw, index): McpScheduleEntry => {
    if (!raw || typeof raw !== "object") throw new Error(`entries[${index}] must be an object`);
    const item = raw as Record<string, unknown>;
    if (typeof item.day !== "string" || !DAYS.has(item.day as ScheduleDay)) {
      throw new Error(`entries[${index}].day is invalid`);
    }
    if (typeof item.start !== "string" || !TIME_RE.test(item.start)) {
      throw new Error(`entries[${index}].start must use HH:MM`);
    }
    if (item.end !== undefined && (typeof item.end !== "string" || !TIME_RE.test(item.end))) {
      throw new Error(`entries[${index}].end must use HH:MM`);
    }
    if (typeof item.end === "string" && item.end <= item.start) {
      throw new Error(`entries[${index}].end must be after start`);
    }
    return {
      day: item.day as ScheduleDay,
      start: item.start,
      end: typeof item.end === "string" ? item.end : undefined,
      title: cleanText(item.title, `entries[${index}].title`, 180),
      location: optionalText(item.location, 180),
      notes: optionalText(item.notes, 500),
    };
  });
  return {
    person,
    scheduleName,
    timezone,
    validFrom,
    validUntil,
    replaceExisting: input.replaceExisting !== false,
    entries,
  };
}

async function ensureMcpSourceAccount(client: PoolClient, principal: AuthPrincipal): Promise<string> {
  const externalAccountId = `member:${principal.memberId}`;
  const result = await client.query<{ id: string }>(
    `INSERT INTO source_accounts(
       household_id, owner_member_id, provider, external_account_id, label, status, auth_mode, config
     ) VALUES ($1, $2, 'mcp', $3, $4, 'connected', 'member-token', $5::jsonb)
     ON CONFLICT(household_id, provider, external_account_id)
     DO UPDATE SET owner_member_id = EXCLUDED.owner_member_id,
                   label = EXCLUDED.label,
                   status = 'connected',
                   updated_at = now()
     RETURNING id`,
    [
      principal.householdId,
      principal.memberId,
      externalAccountId,
      `MCP · ${principal.displayName}`.slice(0, 120),
      JSON.stringify({ memberScoped: true, interface: "mcp" }),
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("failed_to_create_mcp_source_account");
  return id;
}

async function insertSubmissionSourceItem(
  principal: AuthPrincipal,
  input: {
    kind: "mcp_information" | "mcp_schedule";
    title: string;
    bodyText: string;
    visibility: McpSubmissionVisibility;
    metadata: Record<string, unknown>;
  },
): Promise<{ sourceItemId: string; sourceAccountId: string }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const sourceAccountId = await ensureMcpSourceAccount(client, principal);
    const externalId = `submission:${randomUUID()}`;
    const contentHash = createHash("sha256").update(input.bodyText).digest("hex");
    const result = await client.query<{ id: string }>(
      `INSERT INTO source_items(
         household_id, source_account_id, external_id, kind,
         owner_member_id, visibility, occurred_at, title, body_text,
         content_hash, raw_metadata
       ) VALUES ($1,$2,$3,$4,$5,$6::visibility_scope,now(),$7,$8,$9,$10::jsonb)
       RETURNING id`,
      [
        principal.householdId,
        sourceAccountId,
        externalId,
        input.kind,
        principal.memberId,
        input.visibility,
        input.title,
        input.bodyText,
        contentHash,
        JSON.stringify({
          provider: "mcp",
          submittedByMemberId: principal.memberId,
          submittedByDisplayName: principal.displayName,
          ...input.metadata,
        }),
      ],
    );
    const sourceItemId = result.rows[0]?.id;
    if (!sourceItemId) throw new Error("failed_to_create_mcp_source_item");
    await client.query(
      `INSERT INTO action_log(
         household_id, actor_member_id, action_type, target_provider, target_ref,
         approval_state, request, result, completed_at
       ) VALUES ($1,$2,$3,'sol',$4,'not_required',$5::jsonb,$6::jsonb,now())`,
      [
        principal.householdId,
        principal.memberId,
        input.kind === "mcp_schedule" ? "mcp.submit_schedule" : "mcp.submit_information",
        sourceItemId,
        JSON.stringify({ title: input.title, visibility: input.visibility, kind: input.kind }),
        JSON.stringify({ sourceItemId }),
      ],
    );
    await client.query("COMMIT");
    return { sourceItemId, sourceAccountId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function findOrCreateSchedulePerson(
  client: PoolClient,
  principal: AuthPrincipal,
  person: string,
  scope: McpSubmissionVisibility,
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `SELECT e.id
     FROM entities e
     WHERE e.household_id = $1
       AND e.kind = 'person'
       AND e.visibility = $2::visibility_scope
       AND ($2::text = 'family' OR e.owner_member_id = $3)
       AND (
         lower(e.canonical_name) = lower($4)
         OR EXISTS (
           SELECT 1 FROM entity_aliases ea
           WHERE ea.entity_id = e.id AND lower(ea.alias) = lower($4)
         )
       )
     ORDER BY e.updated_at DESC
     LIMIT 1`,
    [principal.householdId, scope, principal.memberId, person],
  );
  const existingId = existing.rows[0]?.id;
  if (existingId) return existingId;
  const created = await client.query<{ id: string }>(
    `INSERT INTO entities(
       household_id, kind, canonical_name, owner_member_id, visibility, metadata
     ) VALUES ($1,'person',$2,$3,$4::visibility_scope,$5::jsonb)
     RETURNING id`,
    [
      principal.householdId,
      person,
      scope === "private" ? principal.memberId : null,
      scope,
      JSON.stringify({ origin: "mcp_schedule" }),
    ],
  );
  const id = created.rows[0]?.id;
  if (!id) throw new Error("failed_to_create_schedule_person");
  return id;
}

async function consolidateSubmittedSchedule(
  principal: AuthPrincipal,
  sourceItemId: string,
  scope: McpSubmissionVisibility,
  schedule: McpScheduleSubmission,
): Promise<{ personEntityId: string; factsCreated: number; factsSuperseded: number }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const personEntityId = await findOrCreateSchedulePerson(client, principal, schedule.person, scope);
    await client.query(
      `INSERT INTO source_links(source_item_id, target_type, target_id, relation)
       VALUES ($1,'entity',$2,'mentioned_in')
       ON CONFLICT(source_item_id,target_type,target_id,relation) DO NOTHING`,
      [sourceItemId, personEntityId],
    );

    let factsSuperseded = 0;
    if (schedule.replaceExisting) {
      const replaced = await client.query(
        `UPDATE facts
         SET status = 'superseded', updated_at = now()
         WHERE household_id = $1
           AND subject_entity_id = $2
           AND predicate = 'routine.schedule'
           AND status = 'active'
           AND visibility = $3::visibility_scope
           AND ($3::text = 'family' OR owner_member_id = $4)
           AND COALESCE(object_value->>'scheduleName','Horario') = $5`,
        [principal.householdId, personEntityId, scope, principal.memberId, schedule.scheduleName],
      );
      factsSuperseded = replaced.rowCount ?? 0;
    }

    let factsCreated = 0;
    for (const entry of schedule.entries) {
      const value = {
        scheduleName: schedule.scheduleName,
        day: entry.day,
        start: entry.start,
        end: entry.end ?? null,
        title: entry.title,
        location: entry.location ?? null,
        notes: entry.notes ?? null,
        timezone: schedule.timezone ?? null,
        validFrom: schedule.validFrom ?? null,
        validUntil: schedule.validUntil ?? null,
      };
      let factId: string | undefined;
      if (!schedule.replaceExisting) {
        const duplicate = await client.query<{ id: string }>(
          `SELECT id FROM facts
           WHERE household_id = $1 AND subject_entity_id = $2
             AND predicate = 'routine.schedule' AND status = 'active'
             AND visibility = $3::visibility_scope
             AND ($3::text = 'family' OR owner_member_id = $4)
             AND object_value = $5::jsonb
           LIMIT 1`,
          [principal.householdId, personEntityId, scope, principal.memberId, JSON.stringify(value)],
        );
        factId = duplicate.rows[0]?.id;
      }
      if (!factId) {
        const created = await client.query<{ id: string }>(
          `INSERT INTO facts(
             household_id, subject_entity_id, predicate, object_value,
             owner_member_id, visibility, confidence, status
           ) VALUES ($1,$2,'routine.schedule',$3::jsonb,$4,$5::visibility_scope,1.0,'active')
           RETURNING id`,
          [
            principal.householdId,
            personEntityId,
            JSON.stringify(value),
            scope === "private" ? principal.memberId : null,
            scope,
          ],
        );
        factId = created.rows[0]?.id;
        if (!factId) throw new Error("failed_to_create_schedule_fact");
        factsCreated += 1;
      }
      await client.query(
        `INSERT INTO source_links(source_item_id, target_type, target_id, relation)
         VALUES ($1,'fact',$2,'derived_from')
         ON CONFLICT(source_item_id,target_type,target_id,relation) DO NOTHING`,
        [sourceItemId, factId],
      );
    }
    await client.query("COMMIT");
    return { personEntityId, factsCreated, factsSuperseded };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function submitMcpInformation(
  principal: AuthPrincipal,
  input: { title?: unknown; text?: unknown; context?: unknown; visibility?: unknown },
): Promise<Record<string, unknown>> {
  const text = cleanText(input.text, "text", 24_000);
  const title = optionalText(input.title, 180) ?? "Información aportada por MCP";
  const context = optionalText(input.context, 1000);
  const scope = visibility(input.visibility);
  const stored = await insertSubmissionSourceItem(principal, {
    kind: "mcp_information",
    title,
    bodyText: text,
    visibility: scope,
    metadata: { submissionType: "information", context: context ?? null },
  });
  return {
    accepted: true,
    sourceItemId: stored.sourceItemId,
    visibility: scope,
    knowledge: "queued_for_consolidation",
    message: "Information was recorded in Life with member provenance. Knowledge consolidation is asynchronous.",
  };
}

export async function submitMcpSchedule(
  principal: AuthPrincipal,
  input: Parameters<typeof normalizeScheduleSubmission>[0] & { visibility?: unknown },
): Promise<Record<string, unknown>> {
  const schedule = normalizeScheduleSubmission(input);
  const scope = visibility(input.visibility);
  const bodyText = [
    `${schedule.scheduleName} · ${schedule.person}`,
    ...schedule.entries.map((entry) =>
      `${entry.day} ${entry.start}${entry.end ? `-${entry.end}` : ""} · ${entry.title}${entry.location ? ` · ${entry.location}` : ""}`,
    ),
  ].join("\n");
  const stored = await insertSubmissionSourceItem(principal, {
    kind: "mcp_schedule",
    title: `${schedule.scheduleName} · ${schedule.person}`.slice(0, 180),
    bodyText,
    visibility: scope,
    metadata: { submissionType: "schedule", schedule },
  });
  try {
    const knowledge = await consolidateSubmittedSchedule(principal, stored.sourceItemId, scope, schedule);
    return {
      accepted: true,
      sourceItemId: stored.sourceItemId,
      visibility: scope,
      schedule: { person: schedule.person, name: schedule.scheduleName, entries: schedule.entries.length },
      knowledge: { status: "consolidated", ...knowledge },
    };
  } catch (error) {
    return {
      accepted: true,
      sourceItemId: stored.sourceItemId,
      visibility: scope,
      schedule: { person: schedule.person, name: schedule.scheduleName, entries: schedule.entries.length },
      knowledge: {
        status: "pending",
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      },
      message: "The Life observation was preserved even though immediate structured Knowledge consolidation failed.",
    };
  }
}
