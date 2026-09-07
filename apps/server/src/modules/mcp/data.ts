import { db } from "../../database/client.js";
import type { AuthPrincipal } from "../auth/session.js";
import { listKnowledgeEntities, type KnowledgeViewKind } from "../knowledge/views.js";
import { listTimeline } from "../life/timeline.js";

export async function getMcpStatus(principal: AuthPrincipal): Promise<Record<string, unknown>> {
  const [sources, people, projects, timeline] = await Promise.all([
    db.query<{ provider: string; count: string }>(
      `SELECT provider, count(*)::text AS count
       FROM source_accounts
       WHERE household_id = $1
         AND (
           owner_member_id = $2
           OR (owner_member_id IS NULL AND $3::text <> 'guest')
         )
       GROUP BY provider
       ORDER BY provider`,
      [principal.householdId, principal.memberId, principal.role],
    ),
    listKnowledgeEntities(principal, "person"),
    listKnowledgeEntities(principal, "project"),
    listTimeline(principal, { limit: 10 }),
  ]);
  return {
    member: {
      id: principal.memberId,
      displayName: principal.displayName,
      role: principal.role,
    },
    sources: sources.rows.map((row) => ({ provider: row.provider, count: Number(row.count) })),
    knowledge: { people: people.length, projects: projects.length },
    recentTimelineItems: timeline.items.length,
    policy: {
      readOnly: true,
      privateDataIsMemberScoped: true,
      householdOwnerIsNotUniversalPrivateReader: true,
    },
  };
}

export async function getMcpTimeline(
  principal: AuthPrincipal,
  options: { before?: string; limit?: number },
) {
  return listTimeline(principal, options);
}

export async function searchMcpLife(
  principal: AuthPrincipal,
  query: string,
  limit = 30,
): Promise<Array<Record<string, unknown>>> {
  const needle = query.trim().slice(0, 240);
  if (needle.length < 2) return [];
  const bounded = Math.max(1, Math.min(60, Math.trunc(limit)));
  const pattern = `%${needle.replace(/[\\%_]/g, "\\$&")}%`;
  const result = await db.query<{
    id: string;
    kind: string;
    occurred_at: Date;
    title: string;
    summary: string | null;
    visibility: string;
    provider: string | null;
    source_label: string | null;
  }>(
    `WITH visible_sources AS (
       SELECT si.id, 'source'::text AS kind, si.occurred_at,
              COALESCE(NULLIF(si.title, ''), sa.label) AS title,
              left(si.body_text, 1600) AS summary, si.visibility::text AS visibility,
              sa.provider, sa.label AS source_label
       FROM source_items si
       JOIN source_accounts sa ON sa.id = si.source_account_id
       WHERE si.household_id = $1 AND si.deleted_at IS NULL
         AND (COALESCE(si.title, '') ILIKE $4 ESCAPE '\\' OR COALESCE(si.body_text, '') ILIKE $4 ESCAPE '\\')
         AND (
           si.owner_member_id = $2
           OR (si.visibility = 'family' AND $3::text <> 'guest')
           OR (si.visibility = 'system' AND $3::text IN ('owner','adult'))
           OR (si.visibility IN ('shared','project') AND EXISTS (
             SELECT 1 FROM visibility_grants vg
             WHERE vg.household_id = si.household_id AND vg.resource_type = 'source_item'
               AND vg.resource_id = si.id AND vg.member_id = $2 AND vg.can_read = true
           ))
         )
     ), visible_events AS (
       SELECT le.id, 'event'::text AS kind, le.starts_at AS occurred_at, le.title,
              left(le.description, 1600) AS summary, le.visibility::text AS visibility,
              CASE WHEN jsonb_typeof(le.metadata->'provider') = 'string' THEN le.metadata->>'provider' END AS provider,
              NULL::text AS source_label
       FROM life_events le
       WHERE le.household_id = $1
         AND (le.title ILIKE $4 ESCAPE '\\' OR COALESCE(le.description, '') ILIKE $4 ESCAPE '\\')
         AND (
           le.owner_member_id = $2
           OR (le.visibility = 'family' AND $3::text <> 'guest')
           OR (le.visibility = 'system' AND $3::text IN ('owner','adult'))
           OR (le.visibility IN ('shared','project') AND EXISTS (
             SELECT 1 FROM visibility_grants vg
             WHERE vg.household_id = le.household_id AND vg.resource_type = 'life_event'
               AND vg.resource_id = le.id AND vg.member_id = $2 AND vg.can_read = true
           ))
         )
     ), visible_tasks AS (
       SELECT t.id, 'task'::text AS kind, COALESCE(t.due_at,t.created_at) AS occurred_at,
              t.title, left(t.description, 1600) AS summary, t.visibility::text AS visibility,
              NULL::text AS provider, NULL::text AS source_label
       FROM tasks t
       WHERE t.household_id = $1
         AND (t.title ILIKE $4 ESCAPE '\\' OR COALESCE(t.description, '') ILIKE $4 ESCAPE '\\')
         AND (
           t.owner_member_id = $2
           OR (t.visibility = 'family' AND $3::text <> 'guest')
           OR (t.visibility = 'system' AND $3::text IN ('owner','adult'))
           OR (t.visibility IN ('shared','project') AND EXISTS (
             SELECT 1 FROM visibility_grants vg
             WHERE vg.household_id = t.household_id AND vg.resource_type = 'task'
               AND vg.resource_id = t.id AND vg.member_id = $2 AND vg.can_read = true
           ))
         )
     )
     SELECT * FROM (
       SELECT * FROM visible_sources
       UNION ALL SELECT * FROM visible_events
       UNION ALL SELECT * FROM visible_tasks
     ) all_items
     ORDER BY occurred_at DESC
     LIMIT $5`,
    [principal.householdId, principal.memberId, principal.role, pattern, bounded],
  );
  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    occurredAt: row.occurred_at.toISOString(),
    title: row.title,
    summary: row.summary ?? undefined,
    visibility: row.visibility,
    provider: row.provider ?? undefined,
    sourceLabel: row.source_label ?? undefined,
  }));
}

export async function listMcpKnowledge(
  principal: AuthPrincipal,
  kind: KnowledgeViewKind,
  query?: string,
  limit = 50,
) {
  const entities = await listKnowledgeEntities(principal, kind);
  const needle = query?.trim().toLocaleLowerCase("es-AR");
  const filtered = !needle
    ? entities
    : entities.filter((entity) =>
        entity.name.toLocaleLowerCase("es-AR").includes(needle) ||
        entity.aliases.some((alias) => alias.toLocaleLowerCase("es-AR").includes(needle)) ||
        entity.facts.some((fact) =>
          fact.predicate.toLocaleLowerCase("es-AR").includes(needle) ||
          JSON.stringify(fact.value ?? "").toLocaleLowerCase("es-AR").includes(needle),
        ),
      );
  return filtered.slice(0, Math.max(1, Math.min(100, Math.trunc(limit))));
}
