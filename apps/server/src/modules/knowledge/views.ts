import { db } from "../../database/client.js";
import type { AuthPrincipal } from "../auth/session.js";

export type KnowledgeViewKind = "person" | "project";

export interface KnowledgeFactView {
  id: string;
  predicate: string;
  value?: unknown;
  objectEntityId?: string;
  confidence: number;
  visibility: string;
  updatedAt: string;
}

export interface KnowledgeEntityView {
  id: string;
  kind: KnowledgeViewKind;
  name: string;
  aliases: string[];
  ownerMemberId?: string;
  visibility: string;
  metadata: Record<string, unknown>;
  facts: KnowledgeFactView[];
  updatedAt: string;
}

export async function listKnowledgeEntities(
  principal: AuthPrincipal,
  kind: KnowledgeViewKind,
): Promise<KnowledgeEntityView[]> {
  const entities = await db.query<{
    id: string;
    kind: KnowledgeViewKind;
    canonical_name: string;
    owner_member_id: string | null;
    visibility: string;
    metadata: Record<string, unknown>;
    updated_at: Date;
  }>(
    `SELECT e.id, e.kind::text, e.canonical_name, e.owner_member_id,
            e.visibility::text, e.metadata, e.updated_at
     FROM entities e
     WHERE e.household_id = $1
       AND e.kind::text = $4
       AND (
         e.owner_member_id = $2
         OR (e.visibility = 'family' AND $3::text <> 'guest')
         OR (e.visibility = 'system' AND $3::text IN ('owner', 'adult'))
         OR (e.visibility IN ('shared', 'project') AND EXISTS (
           SELECT 1 FROM visibility_grants vg
           WHERE vg.household_id = e.household_id
             AND vg.resource_type = 'entity'
             AND vg.resource_id = e.id
             AND vg.member_id = $2 AND vg.can_read = true
         ))
       )
     ORDER BY e.updated_at DESC, e.canonical_name ASC
     LIMIT 250`,
    [principal.householdId, principal.memberId, principal.role, kind],
  );

  if (!entities.rows.length) return [];
  const ids = entities.rows.map((row) => row.id);
  const [aliases, facts] = await Promise.all([
    db.query<{ entity_id: string; alias: string }>(
      `SELECT entity_id, alias
       FROM entity_aliases
       WHERE entity_id = ANY($1::uuid[])
       ORDER BY alias ASC`,
      [ids],
    ),
    db.query<{
      id: string;
      subject_entity_id: string;
      predicate: string;
      object_entity_id: string | null;
      object_value: unknown;
      confidence: number;
      visibility: string;
      updated_at: Date;
    }>(
      `SELECT f.id, f.subject_entity_id, f.predicate, f.object_entity_id,
              f.object_value, f.confidence, f.visibility::text, f.updated_at
       FROM facts f
       WHERE f.household_id = $1
         AND f.subject_entity_id = ANY($4::uuid[])
         AND f.status = 'active'
         AND (
           f.owner_member_id = $2
           OR (f.visibility = 'family' AND $3::text <> 'guest')
           OR (f.visibility = 'system' AND $3::text IN ('owner', 'adult'))
           OR (f.visibility IN ('shared', 'project') AND EXISTS (
             SELECT 1 FROM visibility_grants vg
             WHERE vg.household_id = f.household_id
               AND vg.resource_type = 'fact'
               AND vg.resource_id = f.id
               AND vg.member_id = $2 AND vg.can_read = true
           ))
         )
       ORDER BY f.updated_at DESC
       LIMIT 1000`,
      [principal.householdId, principal.memberId, principal.role, ids],
    ),
  ]);

  const aliasMap = new Map<string, string[]>();
  for (const row of aliases.rows) {
    const list = aliasMap.get(row.entity_id) ?? [];
    list.push(row.alias);
    aliasMap.set(row.entity_id, list);
  }
  const factMap = new Map<string, KnowledgeFactView[]>();
  for (const row of facts.rows) {
    const list = factMap.get(row.subject_entity_id) ?? [];
    list.push({
      id: row.id,
      predicate: row.predicate,
      value: row.object_value ?? undefined,
      objectEntityId: row.object_entity_id ?? undefined,
      confidence: Number(row.confidence),
      visibility: row.visibility,
      updatedAt: row.updated_at.toISOString(),
    });
    factMap.set(row.subject_entity_id, list);
  }

  return entities.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.canonical_name,
    aliases: aliasMap.get(row.id) ?? [],
    ownerMemberId: row.owner_member_id ?? undefined,
    visibility: row.visibility,
    metadata: row.metadata,
    facts: factMap.get(row.id) ?? [],
    updatedAt: row.updated_at.toISOString(),
  }));
}
