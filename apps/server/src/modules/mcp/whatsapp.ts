import { db } from "../../database/client.js";
import type { AuthPrincipal } from "../auth/session.js";

function boundedLimit(value: number | undefined, fallback = 30, max = 80): number {
  return Math.max(1, Math.min(max, Math.trunc(value ?? fallback)));
}

function visibleSql(alias: string): string {
  return `(
    ${alias}.owner_member_id = $2
    OR (${alias}.visibility = 'family' AND $3::text <> 'guest')
    OR (${alias}.visibility = 'system' AND $3::text IN ('owner','adult'))
    OR (${alias}.visibility IN ('shared','project') AND EXISTS (
      SELECT 1 FROM visibility_grants vg
      WHERE vg.household_id = ${alias}.household_id
        AND vg.resource_type = 'source_item'
        AND vg.resource_id = ${alias}.id
        AND vg.member_id = $2
        AND vg.can_read = true
    ))
  )`;
}

function searchPatterns(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((term) => term.length >= 2)
    .slice(0, 8)
    .map((term) => `%${term.replace(/[\\%_]/g, "\\$&")}%`);
}

export async function searchMcpWhatsapp(
  principal: AuthPrincipal,
  query: string,
  limit = 30,
): Promise<Array<Record<string, unknown>>> {
  const needle = query.trim().slice(0, 240);
  if (needle.length < 2) return [];
  const patterns = searchPatterns(needle);
  if (!patterns.length) return [];
  const bounded = boundedLimit(limit, 30, 80);
  const result = await db.query<{
    id: string;
    occurred_at: Date;
    body_text: string | null;
    visibility: string;
    source_label: string;
    conversation_title: string | null;
    sender_label: string | null;
    sender_value: string | null;
    is_from_owner: boolean | null;
    raw_metadata: Record<string, unknown>;
  }>(
    `SELECT si.id, si.occurred_at, left(si.body_text, 4000) AS body_text,
            si.visibility::text AS visibility, sa.label AS source_label,
            c.title AS conversation_title, sender.label AS sender_label,
            sender.external_value AS sender_value, m.is_from_owner, si.raw_metadata
     FROM source_items si
     JOIN source_accounts sa ON sa.id = si.source_account_id
     LEFT JOIN messages m ON m.source_item_id = si.id
     LEFT JOIN conversations c ON c.id = m.conversation_id
     LEFT JOIN identities sender ON sender.id = m.sender_identity_id
     WHERE si.household_id = $1
       AND sa.provider = 'whatsapp'
       AND COALESCE(sa.auth_mode, '') <> 'linked-device-assistant'
       AND si.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1
         FROM unnest($4::text[]) AS query_term(pattern)
         WHERE NOT (
           COALESCE(si.body_text, '') ILIKE query_term.pattern ESCAPE '\\'
           OR COALESCE(c.title, '') ILIKE query_term.pattern ESCAPE '\\'
           OR COALESCE(sender.label, '') ILIKE query_term.pattern ESCAPE '\\'
           OR COALESCE(sender.external_value, '') ILIKE query_term.pattern ESCAPE '\\'
         )
       )
       AND ${visibleSql("si")}
     ORDER BY si.occurred_at DESC
     LIMIT $5`,
    [principal.householdId, principal.memberId, principal.role, patterns, bounded],
  );

  return result.rows.map((row) => ({
    sourceItemId: row.id,
    occurredAt: row.occurred_at.toISOString(),
    text: row.body_text ?? "",
    sourceLabel: row.source_label,
    conversation: row.conversation_title ?? undefined,
    sender: row.is_from_owner
      ? principal.displayName
      : row.sender_label ?? row.sender_value ?? undefined,
    fromMember: Boolean(row.is_from_owner),
    visibility: row.visibility,
    intelligenceScore:
      typeof row.raw_metadata?.intelligenceScore === "number"
        ? row.raw_metadata.intelligenceScore
        : undefined,
    intelligenceRoutes: Array.isArray(row.raw_metadata?.intelligenceRoutes)
      ? row.raw_metadata.intelligenceRoutes
      : [],
  }));
}

export async function listMcpAttentionQueue(
  principal: AuthPrincipal,
  input: {
    hours?: number;
    route?: "any" | "operational" | "knowledge";
    limit?: number;
  } = {},
): Promise<Array<Record<string, unknown>>> {
  const hours = Math.max(1, Math.min(24 * 30, Math.trunc(input.hours ?? 168)));
  const route = input.route ?? "any";
  const limit = boundedLimit(input.limit, 30, 80);
  const result = await db.query<{
    id: string;
    occurred_at: Date;
    body_text: string | null;
    source_label: string;
    conversation_title: string | null;
    sender_label: string | null;
    sender_value: string | null;
    is_from_owner: boolean | null;
    raw_metadata: Record<string, unknown>;
  }>(
    `SELECT si.id, si.occurred_at, left(si.body_text, 3000) AS body_text,
            sa.label AS source_label, c.title AS conversation_title,
            sender.label AS sender_label, sender.external_value AS sender_value,
            m.is_from_owner, si.raw_metadata
     FROM source_items si
     JOIN source_accounts sa ON sa.id = si.source_account_id
     LEFT JOIN messages m ON m.source_item_id = si.id
     LEFT JOIN conversations c ON c.id = m.conversation_id
     LEFT JOIN identities sender ON sender.id = m.sender_identity_id
     WHERE si.household_id = $1
       AND sa.provider = 'whatsapp'
       AND COALESCE(sa.auth_mode, '') <> 'linked-device-assistant'
       AND si.deleted_at IS NULL
       AND si.occurred_at >= now() - ($4::int * interval '1 hour')
       AND jsonb_typeof(si.raw_metadata->'intelligenceRoutes') = 'array'
       AND jsonb_array_length(si.raw_metadata->'intelligenceRoutes') > 0
       AND (
         $5::text = 'any'
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(si.raw_metadata->'intelligenceRoutes') AS route_item(value)
           WHERE route_item.value = $5::text
         )
       )
       AND ${visibleSql("si")}
     ORDER BY COALESCE((si.raw_metadata->>'intelligenceScore')::real, 0) DESC,
              si.occurred_at DESC
     LIMIT $6`,
    [principal.householdId, principal.memberId, principal.role, hours, route, limit],
  );

  return result.rows.map((row) => ({
    sourceItemId: row.id,
    occurredAt: row.occurred_at.toISOString(),
    text: row.body_text ?? "",
    sourceLabel: row.source_label,
    conversation: row.conversation_title ?? undefined,
    sender: row.is_from_owner
      ? principal.displayName
      : row.sender_label ?? row.sender_value ?? undefined,
    fromMember: Boolean(row.is_from_owner),
    score: Number(row.raw_metadata?.intelligenceScore ?? 0),
    priority: row.raw_metadata?.intelligencePriority ?? "normal",
    routes: Array.isArray(row.raw_metadata?.intelligenceRoutes)
      ? row.raw_metadata.intelligenceRoutes
      : [],
    reasons: Array.isArray(row.raw_metadata?.intelligenceReasons)
      ? row.raw_metadata.intelligenceReasons
      : [],
  }));
}
