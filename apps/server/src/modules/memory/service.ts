import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { db } from "../../database/client.js";
import type { AuthPrincipal } from "../auth/session.js";

export type MemoryEntityKind =
  | "person"
  | "organization"
  | "place"
  | "project"
  | "device"
  | "product"
  | "topic"
  | "other";

export type MemoryVisibility = "private" | "family";

export interface MemorySourceInput {
  channel?: string;
  externalId?: string;
  occurredAt?: string;
  label?: string;
}

export interface RememberMemoryInput {
  entityKind: MemoryEntityKind;
  entityName: string;
  predicate: string;
  value: unknown;
  visibility?: MemoryVisibility;
  replaceExisting?: boolean;
  evidenceSourceItemIds?: string[];
  source?: MemorySourceInput;
}

export interface CorrectMemoryInput {
  value: unknown;
  source?: MemorySourceInput;
  evidenceSourceItemIds?: string[];
}

export interface SearchMemoryInput {
  query?: string;
  limit?: number;
  includeInactive?: boolean;
}

const ENTITY_KINDS = new Set<MemoryEntityKind>([
  "person",
  "organization",
  "place",
  "project",
  "device",
  "product",
  "topic",
  "other",
]);

function cleanName(value: string): string {
  const result = value.replace(/\s+/g, " ").trim();
  if (!result || result.length > 180) throw new Error("entityName must be between 1 and 180 characters");
  return result;
}

function cleanPredicate(value: string): string {
  const result = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,119}$/.test(result)) {
    throw new Error("predicate must be a lowercase semantic key such as preference.delivery_day");
  }
  return result;
}

function cleanChannel(value: string | undefined): string {
  const result = (value || "sol").trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "_").slice(0, 80);
  return result || "sol";
}

function serializedJson(value: unknown): string {
  if (value === undefined) throw new Error("value is required");
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > 16_000) {
      throw new Error("value is too large");
    }
    return serialized;
  } catch (error) {
    if (error instanceof Error && error.message === "value is too large") throw error;
    throw new Error("value must be JSON serializable");
  }
}

function occurredAt(source: MemorySourceInput | undefined): Date {
  if (!source?.occurredAt) return new Date();
  const parsed = new Date(source.occurredAt);
  if (Number.isNaN(parsed.getTime())) throw new Error("source.occurredAt must be an ISO date-time");
  return parsed;
}

function evidenceIds(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).filter(Boolean))].slice(0, 20);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

async function ensureMemorySourceAccount(
  client: PoolClient,
  principal: AuthPrincipal,
  source: MemorySourceInput | undefined,
): Promise<string> {
  const channel = cleanChannel(source?.channel);
  const externalAccountId = `${channel}:member:${principal.memberId}`;
  const label = (source?.label?.trim() || `SOL Memory · ${channel}`).slice(0, 120);
  const result = await client.query<{ id: string }>(
    `INSERT INTO source_accounts(
       household_id, owner_member_id, provider, external_account_id, label, status, auth_mode, config
     ) VALUES ($1,$2,'sol_memory',$3,$4,'connected','member-session',$5::jsonb)
     ON CONFLICT(household_id, provider, external_account_id)
     DO UPDATE SET owner_member_id = EXCLUDED.owner_member_id,
                   label = EXCLUDED.label,
                   status = 'connected',
                   config = EXCLUDED.config,
                   updated_at = now()
     RETURNING id`,
    [
      principal.householdId,
      principal.memberId,
      externalAccountId,
      label,
      JSON.stringify({ memberScoped: true, channel, interface: "sol_memory" }),
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("failed_to_create_memory_source_account");
  return id;
}

async function assertVisibleEvidence(
  client: PoolClient,
  principal: AuthPrincipal,
  ids: string[],
): Promise<void> {
  if (!ids.length) return;
  const result = await client.query<{ id: string }>(
    `SELECT si.id
     FROM source_items si
     WHERE si.household_id = $1
       AND si.id = ANY($4::uuid[])
       AND si.deleted_at IS NULL
       AND (
         si.owner_member_id = $2
         OR (si.visibility = 'family' AND $3::text <> 'guest')
         OR (si.visibility = 'system' AND $3::text IN ('owner','adult'))
         OR (si.visibility IN ('shared','project') AND EXISTS (
           SELECT 1 FROM visibility_grants vg
           WHERE vg.household_id = si.household_id
             AND vg.resource_type = 'source_item'
             AND vg.resource_id = si.id
             AND vg.member_id = $2
             AND vg.can_read = true
         ))
       )`,
    [principal.householdId, principal.memberId, principal.role, ids],
  );
  if (new Set(result.rows.map((row) => row.id)).size !== new Set(ids).size) {
    throw new Error("evidence_not_visible_or_missing");
  }
}

async function findOrCreateEntity(
  client: PoolClient,
  principal: AuthPrincipal,
  kind: MemoryEntityKind,
  name: string,
  visibility: MemoryVisibility,
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `SELECT e.id
     FROM entities e
     WHERE e.household_id = $1
       AND e.kind = $2::entity_kind
       AND e.visibility = $3::visibility_scope
       AND ($3::text = 'family' OR e.owner_member_id = $4)
       AND (
         lower(e.canonical_name) = lower($5)
         OR EXISTS (
           SELECT 1 FROM entity_aliases ea
           WHERE ea.entity_id = e.id AND lower(ea.alias) = lower($5)
         )
       )
     ORDER BY e.updated_at DESC
     LIMIT 1`,
    [principal.householdId, kind, visibility, principal.memberId, name],
  );
  if (existing.rows[0]?.id) return existing.rows[0].id;

  const created = await client.query<{ id: string }>(
    `INSERT INTO entities(
       household_id, kind, canonical_name, owner_member_id, visibility, metadata
     ) VALUES ($1,$2::entity_kind,$3,$4,$5::visibility_scope,$6::jsonb)
     RETURNING id`,
    [
      principal.householdId,
      kind,
      name,
      principal.memberId,
      visibility,
      JSON.stringify({ origin: "sol_memory", evidenceClass: "explicitly_declared" }),
    ],
  );
  const id = created.rows[0]?.id;
  if (!id) throw new Error("failed_to_create_memory_entity");
  return id;
}

async function createMemorySourceItem(
  client: PoolClient,
  principal: AuthPrincipal,
  input: {
    entityName: string;
    predicate: string;
    serializedValue: string;
    visibility: MemoryVisibility;
    source?: MemorySourceInput;
    evidenceIds: string[];
    action: "remember" | "correct";
    replacesFactId?: string;
  },
): Promise<string> {
  const sourceAccountId = await ensureMemorySourceAccount(client, principal, input.source);
  const channel = cleanChannel(input.source?.channel);
  const bodyText = `${input.entityName} · ${input.predicate}\n${input.serializedValue}`;
  const sourceItem = await client.query<{ id: string }>(
    `INSERT INTO source_items(
       household_id, source_account_id, external_id, kind,
       owner_member_id, visibility, occurred_at, title, body_text,
       content_hash, raw_metadata
     ) VALUES ($1,$2,$3,'explicit_memory',$4,$5::visibility_scope,$6,$7,$8,$9,$10::jsonb)
     RETURNING id`,
    [
      principal.householdId,
      sourceAccountId,
      `memory:${randomUUID()}`,
      principal.memberId,
      input.visibility,
      occurredAt(input.source),
      `Memoria · ${input.entityName} · ${input.predicate}`.slice(0, 240),
      bodyText,
      createHash("sha256").update(bodyText).digest("hex"),
      JSON.stringify({
        provider: "sol_memory",
        interface: "sol_memory",
        channel,
        sourceExternalId: input.source?.externalId,
        submissionType: "explicit_memory_fact",
        evidenceClass: "explicitly_declared",
        action: input.action,
        replacesFactId: input.replacesFactId,
        evidenceSourceItemIds: input.evidenceIds,
      }),
    ],
  );
  const sourceItemId = sourceItem.rows[0]?.id;
  if (!sourceItemId) throw new Error("failed_to_create_memory_source_item");
  return sourceItemId;
}

async function linkSource(
  client: PoolClient,
  sourceItemId: string,
  entityId: string,
  factId: string,
  ids: string[],
  correctedFactId?: string,
): Promise<void> {
  await client.query(
    `INSERT INTO source_links(source_item_id, target_type, target_id, relation)
     VALUES ($1,'entity',$2,'mentioned_in'),($1,'fact',$3,'derived_from')
     ON CONFLICT(source_item_id,target_type,target_id,relation) DO NOTHING`,
    [sourceItemId, entityId, factId],
  );
  if (correctedFactId) {
    await client.query(
      `INSERT INTO source_links(source_item_id, target_type, target_id, relation)
       VALUES ($1,'fact',$2,'corrects')
       ON CONFLICT(source_item_id,target_type,target_id,relation) DO NOTHING`,
      [sourceItemId, correctedFactId],
    );
  }
  for (const id of ids) {
    await client.query(
      `INSERT INTO source_links(source_item_id, target_type, target_id, relation)
       VALUES ($1,'fact',$2,'supports'),($1,'entity',$3,'mentioned_in')
       ON CONFLICT(source_item_id,target_type,target_id,relation) DO NOTHING`,
      [id, factId, entityId],
    );
  }
}

async function markExplicitSourceAnalyzed(
  client: PoolClient,
  householdId: string,
  sourceItemId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO knowledge_consolidation_items(
       source_item_id, household_id, status, attempts, provider,
       model_metadata, last_error, analyzed_at
     ) VALUES ($1,$2,'analyzed',1,'deterministic:sol_memory',$3::jsonb,NULL,now())
     ON CONFLICT(source_item_id)
     DO UPDATE SET status = 'analyzed',
                   attempts = knowledge_consolidation_items.attempts + 1,
                   provider = EXCLUDED.provider,
                   model_metadata = EXCLUDED.model_metadata,
                   last_error = NULL,
                   analyzed_at = now(),
                   updated_at = now()`,
    [sourceItemId, householdId, JSON.stringify({ processor: "sol_memory", version: 1, evidenceClass: "explicitly_declared" })],
  );
}

export async function rememberMemoryFact(
  principal: AuthPrincipal,
  input: RememberMemoryInput,
): Promise<Record<string, unknown>> {
  if (!ENTITY_KINDS.has(input.entityKind)) throw new Error("invalid_entity_kind");
  const entityName = cleanName(input.entityName);
  const predicate = cleanPredicate(input.predicate);
  const value = serializedJson(input.value);
  const visibility: MemoryVisibility = input.visibility === "family" ? "family" : "private";
  const replaceExisting = input.replaceExisting === true;
  const ids = evidenceIds(input.evidenceSourceItemIds);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await assertVisibleEvidence(client, principal, ids);
    const entityId = await findOrCreateEntity(client, principal, input.entityKind, entityName, visibility);

    let superseded = 0;
    if (replaceExisting) {
      const result = await client.query(
        `UPDATE facts
         SET status = 'superseded', updated_at = now()
         WHERE household_id = $1
           AND subject_entity_id = $2
           AND predicate = $3
           AND status = 'active'
           AND owner_member_id = $4`,
        [principal.householdId, entityId, predicate, principal.memberId],
      );
      superseded = result.rowCount ?? 0;
    }

    let factId: string | undefined;
    if (!replaceExisting) {
      const duplicate = await client.query<{ id: string }>(
        `SELECT id
         FROM facts
         WHERE household_id = $1
           AND subject_entity_id = $2
           AND predicate = $3
           AND object_value = $4::jsonb
           AND status = 'active'
           AND owner_member_id = $5
         LIMIT 1`,
        [principal.householdId, entityId, predicate, value, principal.memberId],
      );
      factId = duplicate.rows[0]?.id;
    }

    let created = false;
    if (!factId) {
      const fact = await client.query<{ id: string }>(
        `INSERT INTO facts(
           household_id, subject_entity_id, predicate, object_value,
           owner_member_id, visibility, confidence, status
         ) VALUES ($1,$2,$3,$4::jsonb,$5,$6::visibility_scope,1.0,'active')
         RETURNING id`,
        [principal.householdId, entityId, predicate, value, principal.memberId, visibility],
      );
      factId = fact.rows[0]?.id;
      if (!factId) throw new Error("failed_to_create_memory_fact");
      created = true;
    }

    const sourceItemId = await createMemorySourceItem(client, principal, {
      entityName,
      predicate,
      serializedValue: value,
      visibility,
      source: input.source,
      evidenceIds: ids,
      action: "remember",
    });
    await linkSource(client, sourceItemId, entityId, factId, ids);
    await markExplicitSourceAnalyzed(client, principal.householdId, sourceItemId);

    await client.query(
      `INSERT INTO action_log(
         household_id, actor_member_id, action_type, target_provider, target_ref,
         approval_state, request, result, completed_at
       ) VALUES ($1,$2,'memory.remember','sol_memory',$3,'user_confirmed',$4::jsonb,$5::jsonb,now())`,
      [
        principal.householdId,
        principal.memberId,
        factId,
        JSON.stringify({ entityKind: input.entityKind, entityName, predicate, visibility, replaceExisting, channel: cleanChannel(input.source?.channel) }),
        JSON.stringify({ sourceItemId, entityId, factId, evidenceCount: ids.length }),
      ],
    );

    await client.query("COMMIT");
    return {
      accepted: true,
      evidenceClass: "explicitly_declared",
      entityId,
      factId,
      sourceItemId,
      created,
      superseded,
      ownerMemberId: principal.memberId,
      visibility,
      sourceChannel: cleanChannel(input.source?.channel),
      evidenceSourceItemIds: ids,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function searchMemories(
  principal: AuthPrincipal,
  input: SearchMemoryInput = {},
): Promise<Array<Record<string, unknown>>> {
  const query = (input.query ?? "").trim().slice(0, 240);
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 30)));
  const pattern = query ? `%${escapeLike(query)}%` : null;
  const result = await db.query<{
    fact_id: string;
    entity_id: string;
    entity_kind: string;
    entity_name: string;
    predicate: string;
    object_value: unknown;
    owner_member_id: string | null;
    visibility: string;
    status: string;
    created_at: Date;
    updated_at: Date;
    sources: unknown;
  }>(
    `SELECT f.id AS fact_id, e.id AS entity_id, e.kind::text AS entity_kind,
            e.canonical_name AS entity_name, f.predicate, f.object_value,
            f.owner_member_id, f.visibility::text AS visibility, f.status,
            f.created_at, f.updated_at,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'sourceItemId', si.id,
                'provider', sa.provider,
                'sourceLabel', sa.label,
                'occurredAt', si.occurred_at,
                'title', si.title,
                'relation', sl.relation,
                'channel', si.raw_metadata->>'channel',
                'sourceExternalId', si.raw_metadata->>'sourceExternalId',
                'evidenceClass', si.raw_metadata->>'evidenceClass'
              ) ORDER BY si.occurred_at DESC)
              FROM source_links sl
              JOIN source_items si ON si.id = sl.source_item_id
              JOIN source_accounts sa ON sa.id = si.source_account_id
              WHERE sl.target_type = 'fact' AND sl.target_id = f.id
                AND si.deleted_at IS NULL
                AND (
                  si.owner_member_id = $2
                  OR (si.visibility = 'family' AND $3::text <> 'guest')
                  OR (si.visibility = 'system' AND $3::text IN ('owner','adult'))
                  OR (si.visibility IN ('shared','project') AND EXISTS (
                    SELECT 1 FROM visibility_grants vg
                    WHERE vg.household_id = si.household_id
                      AND vg.resource_type = 'source_item'
                      AND vg.resource_id = si.id
                      AND vg.member_id = $2
                      AND vg.can_read = true
                  ))
                )
            ), '[]'::jsonb) AS sources
     FROM facts f
     JOIN entities e ON e.id = f.subject_entity_id
     WHERE f.household_id = $1
       AND ($4::boolean OR f.status = 'active')
       AND (
         f.owner_member_id = $2
         OR (f.visibility = 'family' AND $3::text <> 'guest')
         OR (f.visibility = 'system' AND $3::text IN ('owner','adult'))
         OR (f.visibility IN ('shared','project') AND EXISTS (
           SELECT 1 FROM visibility_grants vg
           WHERE vg.household_id = f.household_id
             AND vg.resource_type = 'fact'
             AND vg.resource_id = f.id
             AND vg.member_id = $2
             AND vg.can_read = true
         ))
       )
       AND ($5::text IS NULL
         OR e.canonical_name ILIKE $5 ESCAPE '\\'
         OR f.predicate ILIKE $5 ESCAPE '\\'
         OR f.object_value::text ILIKE $5 ESCAPE '\\')
     ORDER BY f.updated_at DESC
     LIMIT $6`,
    [principal.householdId, principal.memberId, principal.role, input.includeInactive === true, pattern, limit],
  );

  return result.rows.map((row) => ({
    factId: row.fact_id,
    entityId: row.entity_id,
    entityKind: row.entity_kind,
    entityName: row.entity_name,
    predicate: row.predicate,
    value: row.object_value,
    ownerMemberId: row.owner_member_id ?? undefined,
    visibility: row.visibility,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    sources: row.sources,
  }));
}

export async function correctMemoryFact(
  principal: AuthPrincipal,
  factId: string,
  input: CorrectMemoryInput,
): Promise<Record<string, unknown>> {
  const value = serializedJson(input.value);
  const ids = evidenceIds(input.evidenceSourceItemIds);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await assertVisibleEvidence(client, principal, ids);
    const existing = await client.query<{
      id: string;
      entity_id: string;
      entity_name: string;
      predicate: string;
      visibility: MemoryVisibility;
    }>(
      `SELECT f.id, f.subject_entity_id AS entity_id, e.canonical_name AS entity_name,
              f.predicate, f.visibility::text AS visibility
       FROM facts f
       JOIN entities e ON e.id = f.subject_entity_id
       WHERE f.id = $1 AND f.household_id = $2
         AND f.owner_member_id = $3 AND f.status = 'active'
       FOR UPDATE`,
      [factId, principal.householdId, principal.memberId],
    );
    const old = existing.rows[0];
    if (!old) throw new Error("memory_not_found_or_not_owned");

    await client.query(`UPDATE facts SET status = 'superseded', updated_at = now() WHERE id = $1`, [factId]);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO facts(
         household_id, subject_entity_id, predicate, object_value,
         owner_member_id, visibility, confidence, status
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6::visibility_scope,1.0,'active')
       RETURNING id`,
      [principal.householdId, old.entity_id, old.predicate, value, principal.memberId, old.visibility],
    );
    const newFactId = inserted.rows[0]?.id;
    if (!newFactId) throw new Error("failed_to_create_corrected_memory");

    const sourceItemId = await createMemorySourceItem(client, principal, {
      entityName: old.entity_name,
      predicate: old.predicate,
      serializedValue: value,
      visibility: old.visibility,
      source: input.source,
      evidenceIds: ids,
      action: "correct",
      replacesFactId: factId,
    });
    await linkSource(client, sourceItemId, old.entity_id, newFactId, ids, factId);
    await markExplicitSourceAnalyzed(client, principal.householdId, sourceItemId);

    await client.query(
      `INSERT INTO action_log(
         household_id, actor_member_id, action_type, target_provider, target_ref,
         approval_state, request, result, completed_at
       ) VALUES ($1,$2,'memory.correct','sol_memory',$3,'user_confirmed',$4::jsonb,$5::jsonb,now())`,
      [
        principal.householdId,
        principal.memberId,
        newFactId,
        JSON.stringify({ correctedFactId: factId, channel: cleanChannel(input.source?.channel) }),
        JSON.stringify({ oldFactId: factId, newFactId, sourceItemId }),
      ],
    );

    await client.query("COMMIT");
    return {
      accepted: true,
      oldFactId: factId,
      newFactId,
      sourceItemId,
      status: "corrected",
      evidenceClass: "explicitly_declared",
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function forgetMemoryFact(
  principal: AuthPrincipal,
  factId: string,
): Promise<Record<string, unknown>> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query<{ id: string }>(
      `UPDATE facts
       SET status = 'forgotten', updated_at = now()
       WHERE id = $1 AND household_id = $2
         AND owner_member_id = $3 AND status = 'active'
       RETURNING id`,
      [factId, principal.householdId, principal.memberId],
    );
    if (!updated.rows[0]?.id) throw new Error("memory_not_found_or_not_owned");

    await client.query(
      `INSERT INTO action_log(
         household_id, actor_member_id, action_type, target_provider, target_ref,
         approval_state, request, result, completed_at
       ) VALUES ($1,$2,'memory.forget','sol_memory',$3,'user_confirmed',$4::jsonb,$5::jsonb,now())`,
      [
        principal.householdId,
        principal.memberId,
        factId,
        JSON.stringify({ factId }),
        JSON.stringify({ factId, status: "forgotten" }),
      ],
    );
    await client.query("COMMIT");
    return { accepted: true, factId, status: "forgotten" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
