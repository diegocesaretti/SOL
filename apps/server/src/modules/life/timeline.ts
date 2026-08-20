import { db } from "../../database/client.js";
import type { AuthPrincipal } from "../auth/session.js";
import { scoreIntelligenceCandidate } from "../knowledge/intelligence-gate.js";

export type TimelineItemType = "source" | "event" | "task";

export interface TimelineItem {
  id: string;
  type: TimelineItemType;
  occurredAt: string;
  title: string;
  summary?: string;
  ownerMemberId?: string;
  visibility: "private" | "shared" | "family" | "project" | "system";
  provider?: string;
  sourceLabel?: string;
  metadata?: Record<string, unknown>;
}

function safeBefore(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function intelligenceMetadata(input: {
  provider: string;
  title: string | null;
  bodyText: string | null;
  metadata: Record<string, unknown>;
}): Record<string, unknown> {
  if (input.provider !== "whatsapp" && input.provider !== "gmail") return input.metadata;
  if (typeof input.metadata.intelligenceScore === "number") return input.metadata;
  const gate = scoreIntelligenceCandidate({
    provider: input.provider,
    title: input.title,
    bodyText: input.bodyText,
    metadata: input.metadata,
  });
  return {
    ...input.metadata,
    intelligenceCandidate: gate.candidate,
    intelligenceScore: gate.score,
    intelligencePriority: gate.priority,
    intelligenceRoutes: gate.routes,
    intelligenceOperationalScore: gate.operationalScore,
    intelligenceKnowledgeScore: gate.knowledgeScore,
    intelligenceReasons: gate.reasons,
  };
}

export async function listTimeline(
  principal: AuthPrincipal,
  options: { before?: string; limit?: number } = {},
): Promise<{ items: TimelineItem[]; nextBefore?: string }> {
  const limit = Math.max(10, Math.min(options.limit ?? 60, 120));
  const perType = Math.min(limit, 80);
  const before = safeBefore(options.before);
  const role = principal.role;

  const [sources, events, tasks] = await Promise.all([
    db.query<{
      id: string;
      occurred_at: Date;
      title: string | null;
      body_text: string | null;
      owner_member_id: string | null;
      visibility: TimelineItem["visibility"];
      raw_metadata: Record<string, unknown>;
      provider: string;
      source_label: string;
    }>(
      `SELECT si.id, si.occurred_at, si.title, si.body_text, si.owner_member_id,
              si.visibility::text, si.raw_metadata, sa.provider, sa.label AS source_label
       FROM source_items si
       JOIN source_accounts sa ON sa.id = si.source_account_id
       WHERE si.household_id = $1
         AND si.deleted_at IS NULL
         AND ($4::timestamptz IS NULL OR si.occurred_at < $4)
         AND (
           si.owner_member_id = $2
           OR (si.visibility = 'family' AND $3::text <> 'guest')
           OR (si.visibility = 'system' AND $3::text IN ('owner', 'adult'))
           OR (si.visibility IN ('shared', 'project') AND EXISTS (
             SELECT 1 FROM visibility_grants vg
             WHERE vg.household_id = si.household_id
               AND vg.resource_type = 'source_item'
               AND vg.resource_id = si.id
               AND vg.member_id = $2 AND vg.can_read = true
           ))
         )
       ORDER BY si.occurred_at DESC
       LIMIT $5`,
      [principal.householdId, principal.memberId, role, before, perType],
    ),
    db.query<{
      id: string;
      starts_at: Date;
      title: string;
      description: string | null;
      owner_member_id: string | null;
      visibility: TimelineItem["visibility"];
      event_type: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT le.id, le.starts_at, le.title, le.description, le.owner_member_id,
              le.visibility::text, le.event_type, le.metadata
       FROM life_events le
       WHERE le.household_id = $1
         AND ($4::timestamptz IS NULL OR le.starts_at < $4)
         AND (
           le.owner_member_id = $2
           OR (le.visibility = 'family' AND $3::text <> 'guest')
           OR (le.visibility = 'system' AND $3::text IN ('owner', 'adult'))
           OR (le.visibility IN ('shared', 'project') AND EXISTS (
             SELECT 1 FROM visibility_grants vg
             WHERE vg.household_id = le.household_id
               AND vg.resource_type = 'life_event'
               AND vg.resource_id = le.id
               AND vg.member_id = $2 AND vg.can_read = true
           ))
         )
       ORDER BY le.starts_at DESC
       LIMIT $5`,
      [principal.householdId, principal.memberId, role, before, perType],
    ),
    db.query<{
      id: string;
      point_at: Date;
      title: string;
      description: string | null;
      owner_member_id: string | null;
      visibility: TimelineItem["visibility"];
      status: string;
      due_at: Date | null;
    }>(
      `SELECT t.id, COALESCE(t.due_at, t.created_at) AS point_at, t.title, t.description,
              t.owner_member_id, t.visibility::text, t.status::text, t.due_at
       FROM tasks t
       WHERE t.household_id = $1
         AND ($4::timestamptz IS NULL OR COALESCE(t.due_at, t.created_at) < $4)
         AND (
           t.owner_member_id = $2
           OR (t.visibility = 'family' AND $3::text <> 'guest')
           OR (t.visibility = 'system' AND $3::text IN ('owner', 'adult'))
           OR (t.visibility IN ('shared', 'project') AND EXISTS (
             SELECT 1 FROM visibility_grants vg
             WHERE vg.household_id = t.household_id
               AND vg.resource_type = 'task'
               AND vg.resource_id = t.id
               AND vg.member_id = $2 AND vg.can_read = true
           ))
         )
       ORDER BY COALESCE(t.due_at, t.created_at) DESC
       LIMIT $5`,
      [principal.householdId, principal.memberId, role, before, perType],
    ),
  ]);

  const items: TimelineItem[] = [
    ...sources.rows.map((row) => ({
      id: row.id,
      type: "source" as const,
      occurredAt: row.occurred_at.toISOString(),
      title: row.title?.trim() || (row.provider === "whatsapp" ? "Mensaje de WhatsApp" : row.source_label),
      summary: row.body_text?.trim().slice(0, 1200) || undefined,
      ownerMemberId: row.owner_member_id ?? undefined,
      visibility: row.visibility,
      provider: row.provider,
      sourceLabel: row.source_label,
      metadata: intelligenceMetadata({
        provider: row.provider,
        title: row.title,
        bodyText: row.body_text,
        metadata: row.raw_metadata,
      }),
    })),
    ...events.rows.map((row) => ({
      id: row.id,
      type: "event" as const,
      occurredAt: row.starts_at.toISOString(),
      title: row.title,
      summary: row.description?.trim().slice(0, 1200) || undefined,
      ownerMemberId: row.owner_member_id ?? undefined,
      visibility: row.visibility,
      provider: typeof row.metadata?.provider === "string" ? row.metadata.provider : undefined,
      metadata: { eventType: row.event_type, ...row.metadata },
    })),
    ...tasks.rows.map((row) => ({
      id: row.id,
      type: "task" as const,
      occurredAt: row.point_at.toISOString(),
      title: row.title,
      summary: row.description?.trim().slice(0, 1200) || undefined,
      ownerMemberId: row.owner_member_id ?? undefined,
      visibility: row.visibility,
      metadata: { status: row.status, dueAt: row.due_at?.toISOString() ?? null },
    })),
  ]
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, limit);

  const nextBefore = items.length === limit ? items[items.length - 1]?.occurredAt : undefined;
  return { items, nextBefore };
}
