import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { db } from "../../database/client.js";
import type { AuthPrincipal } from "../auth/session.js";

export type NexoMemoryEntityKind =
  | "person"
  | "organization"
  | "place"
  | "project"
  | "product"
  | "topic"
  | "other";

export interface NexoMemoryFactInput {
  entityKind: NexoMemoryEntityKind;
  entityName: string;
  predicate: string;
  value: unknown;
  visibility?: "private" | "family";
  replaceExisting?: boolean;
  evidenceSourceItemIds?: string[];
}

const ENTITY_KINDS = new Set<NexoMemoryEntityKind>([
  "person",
  "organization",
  "place",
  "project",
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

function jsonValue(value: unknown): string {
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

async function ensureNexoMcpSourceAccount(client: PoolClient, principal: AuthPrincipal): Promise<string> {
  const externalAccountId = `member:${principal.memberId}`;
  const result = await client.query<{ id: string }>(
    `INSERT INTO source_accounts(
       household_id, owner_member_id, provider, external_account_id, label, status, auth_mode, config
     ) VALUES ($1,$2,'mcp',$3,$4,'connected','member-token',$5::jsonb)
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
      `Nexo MCP · ${principal.displayName}`.slice(0, 120),
      JSON.stringify({ memberScoped: true, interface: "nexo_mcp" }),
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("failed_to_create_nexo_mcp_source_account");
  return id;
}

async function assertVisibleEvidence(
  client: PoolClient,
  principal: AuthPrincipal,
  evidenceIds: string[],
): Promise<void> {
  if (!evidenceIds.length) return;
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
    [principal.householdId, principal.memberId, principal.role, evidenceIds],
  );
  if (new Set(result.rows.map((row) => row.id)).size !== new Set(evidenceIds).size) {
    throw new Error("evidence_not_visible_or_missing");
  }
}

async function findOrCreateEntity(
  client: PoolClient,
  principal: AuthPrincipal,
  kind: NexoMemoryEntityKind,
  name: string,
  visibility: "private" | "family",
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
      visibility === "private" ? principal.memberId : null,
      visibility,
      JSON.stringify({ origin: "nexo_mcp_memory" }),
    ],
  );
  const id = created.rows[0]?.id;
  if (!id) throw new Error("failed_to_create_memory_entity");
  return id;
}

export async function rememberMcpFact(
  principal: AuthPrincipal,
  input: NexoMemoryFactInput,
): Promise<Record<string, unknown>> {
  if (!ENTITY_KINDS.has(input.entityKind)) throw new Error("invalid_entity_kind");
  const entityName = cleanName(input.entityName);
  const predicate = cleanPredicate(input.predicate);
  const serializedValue = jsonValue(input.value);
  const visibility = input.visibility === "family" ? "family" : "private";
  const replaceExisting = input.replaceExisting === true;
  const evidenceIds = [...new Set((input.evidenceSourceItemIds ?? []).filter(Boolean))].slice(0, 20);
  const bodyText = `${entityName} · ${predicate}\n${serializedValue}`;

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await assertVisibleEvidence(client, principal, evidenceIds);
    const sourceAccountId = await ensureNexoMcpSourceAccount(client, principal);
    const sourceItem = await client.query<{ id: string }>(
      `INSERT INTO source_items(
         household_id, source_account_id, external_id, kind,
         owner_member_id, visibility, occurred_at, title, body_text,
         content_hash, raw_metadata
       ) VALUES ($1,$2,$3,'mcp_memory',$4,$5::visibility_scope,now(),$6,$7,$8,$9::jsonb)
       RETURNING id`,
      [
        principal.householdId,
        sourceAccountId,
        `memory:${randomUUID()}`,
        principal.memberId,
        visibility,
        `Memoria · ${entityName} · ${predicate}`.slice(0, 240),
        bodyText,
        createHash("sha256").update(bodyText).digest("hex"),
        JSON.stringify({
          provider: "mcp",
          interface: "nexo_mcp",
          submissionType: "memory_fact",
          entityKind: input.entityKind,
          entityName,
          predicate,
          evidenceSourceItemIds: evidenceIds,
          replaceExisting,
        }),
      ],
    );
    const sourceItemId = sourceItem.rows[0]?.id;
    if (!sourceItemId) throw new Error("failed_to_create_memory_source_item");

    const entityId = await findOrCreateEntity(
      client,
      principal,
      input.entityKind,
      entityName,
      visibility,
    );

    let superseded = 0;
    if (replaceExisting) {
      const result = await client.query(
        `UPDATE facts
         SET status = 'superseded', updated_at = now()
         WHERE household_id = $1
           AND subject_entity_id = $2
           AND predicate = $3
           AND status = 'active'
           AND visibility = $4::visibility_scope
           AND ($4::text = 'family' OR owner_member_id = $5)`,
        [principal.householdId, entityId, predicate, visibility, principal.memberId],
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
           AND visibility = $5::visibility_scope
           AND ($5::text = 'family' OR owner_member_id = $6)
         LIMIT 1`,
        [
          principal.householdId,
          entityId,
          predicate,
          serializedValue,
          visibility,
          principal.memberId,
        ],
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
        [
          principal.householdId,
          entityId,
          predicate,
          serializedValue,
          visibility === "private" ? principal.memberId : null,
          visibility,
        ],
      );
      factId = fact.rows[0]?.id;
      if (!factId) throw new Error("failed_to_create_memory_fact");
      created = true;
    }

    await client.query(
      `INSERT INTO source_links(source_item_id, target_type, target_id, relation)
       VALUES ($1,'entity',$2,'mentioned_in'),($1,'fact',$3,'derived_from')
       ON CONFLICT(source_item_id,target_type,target_id,relation) DO NOTHING`,
      [sourceItemId, entityId, factId],
    );
    for (const evidenceId of evidenceIds) {
      await client.query(
        `INSERT INTO source_links(source_item_id, target_type, target_id, relation)
         VALUES ($1,'fact',$2,'supports'),($1,'entity',$3,'mentioned_in')
         ON CONFLICT(source_item_id,target_type,target_id,relation) DO NOTHING`,
        [evidenceId, factId, entityId],
      );
    }

    await client.query(
      `INSERT INTO knowledge_consolidation_items(
         source_item_id, household_id, status, attempts, provider,
         model_metadata, last_error, analyzed_at
       ) VALUES ($1,$2,'analyzed',1,'deterministic:nexo_mcp_memory',$3::jsonb,NULL,now())
       ON CONFLICT(source_item_id)
       DO UPDATE SET status = 'analyzed',
                     attempts = knowledge_consolidation_items.attempts + 1,
                     provider = EXCLUDED.provider,
                     model_metadata = EXCLUDED.model_metadata,
                     last_error = NULL,
                     analyzed_at = now(),
                     updated_at = now()`,
      [sourceItemId, principal.householdId, JSON.stringify({ processor: "nexo_mcp_memory", version: 1 })],
    );

    await client.query(
      `INSERT INTO action_log(
         household_id, actor_member_id, action_type, target_provider, target_ref,
         approval_state, request, result, completed_at
       ) VALUES ($1,$2,'mcp.remember_fact','nexo',$3,'user_confirmed',$4::jsonb,$5::jsonb,now())`,
      [
        principal.householdId,
        principal.memberId,
        factId,
        JSON.stringify({ entityKind: input.entityKind, entityName, predicate, visibility, replaceExisting }),
        JSON.stringify({ sourceItemId, entityId, factId, evidenceCount: evidenceIds.length }),
      ],
    );

    await client.query("COMMIT");
    return {
      accepted: true,
      entityId,
      factId,
      sourceItemId,
      created,
      superseded,
      visibility,
      evidenceSourceItemIds: evidenceIds,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
