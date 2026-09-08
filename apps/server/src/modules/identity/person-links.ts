import { db } from "../../database/client.js";
import type { AuthPrincipal } from "../auth/session.js";
import type { SolPluginRuntimePrincipal } from "../plugins/types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PersonIdentityView {
  id: string;
  provider: string;
  kind: string;
  externalValue: string;
  label?: string;
  pluginId?: string;
  metadata: Record<string, unknown>;
}

export interface CanonicalPersonView {
  id: string;
  name: string;
  ownerMemberId?: string;
  visibility: string;
  metadata: Record<string, unknown>;
  identities: PersonIdentityView[];
  updatedAt: string;
}

export class PersonLinkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonLinkValidationError";
  }
}

function requireUuid(value: string, name: string): string {
  if (!UUID_RE.test(value)) throw new PersonLinkValidationError(`${name}_invalid`);
  return value;
}

function canManagePeople(principal: AuthPrincipal): boolean {
  return principal.role === "owner" || principal.role === "adult";
}

export async function listCanonicalPeople(principal: AuthPrincipal): Promise<CanonicalPersonView[]> {
  const people = await db.query<{
    id: string;
    canonical_name: string;
    owner_member_id: string | null;
    visibility: string;
    metadata: Record<string, unknown>;
    updated_at: Date;
  }>(
    `SELECT e.id, e.canonical_name, e.owner_member_id, e.visibility::text,
            e.metadata, e.updated_at
     FROM entities e
     WHERE e.household_id = $1
       AND e.kind = 'person'
       AND COALESCE(e.metadata->>'supersededBy', '') = ''
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
     ORDER BY lower(e.canonical_name), e.id
     LIMIT 500`,
    [principal.householdId, principal.memberId, principal.role],
  );

  if (!people.rows.length) return [];
  const ids = people.rows.map((row) => row.id);
  const identities = await db.query<{
    id: string;
    entity_id: string;
    provider: string;
    kind: string;
    external_value: string;
    label: string | null;
    metadata: Record<string, unknown>;
    plugin_id: string | null;
  }>(
    `SELECT i.id, l.entity_id, i.provider, i.kind, i.external_value, i.label,
            i.metadata, pib.plugin_id
     FROM identity_entity_links l
     JOIN identities i ON i.id = l.identity_id
     LEFT JOIN plugin_identity_bindings pib
       ON pib.household_id = i.household_id AND pib.identity_id = i.id
     WHERE l.entity_id = ANY($1::uuid[])
     ORDER BY lower(COALESCE(i.label, i.external_value)), i.id`,
    [ids],
  );

  const byPerson = new Map<string, PersonIdentityView[]>();
  for (const row of identities.rows) {
    const list = byPerson.get(row.entity_id) ?? [];
    list.push({
      id: row.id,
      provider: row.provider,
      kind: row.kind,
      externalValue: row.external_value,
      ...(row.label ? { label: row.label } : {}),
      ...(row.plugin_id ? { pluginId: row.plugin_id } : {}),
      metadata: row.metadata ?? {},
    });
    byPerson.set(row.entity_id, list);
  }

  return people.rows.map((row) => ({
    id: row.id,
    name: row.canonical_name,
    ...(row.owner_member_id ? { ownerMemberId: row.owner_member_id } : {}),
    visibility: row.visibility,
    metadata: row.metadata ?? {},
    identities: byPerson.get(row.id) ?? [],
    updatedAt: row.updated_at.toISOString(),
  }));
}

async function assertUserVisibleTarget(principal: AuthPrincipal, entityId: string): Promise<void> {
  const result = await db.query<{ id: string }>(
    `SELECT e.id
     FROM entities e
     WHERE e.id = $1 AND e.household_id = $2 AND e.kind = 'person'
       AND (
         e.owner_member_id = $3
         OR (e.visibility = 'family' AND $4::text <> 'guest')
         OR (e.visibility = 'system' AND $4::text IN ('owner', 'adult'))
         OR (e.visibility IN ('shared', 'project') AND EXISTS (
           SELECT 1 FROM visibility_grants vg
           WHERE vg.household_id = e.household_id
             AND vg.resource_type = 'entity'
             AND vg.resource_id = e.id
             AND vg.member_id = $3 AND vg.can_read = true
         ))
       )
     LIMIT 1`,
    [entityId, principal.householdId, principal.memberId, principal.role],
  );
  if (!result.rows[0]) throw new PersonLinkValidationError("person_not_found");
}

async function assertPluginVisibleTarget(principal: SolPluginRuntimePrincipal, entityId: string): Promise<void> {
  const result = await db.query<{ id: string }>(
    `SELECT id
     FROM entities
     WHERE id = $1 AND household_id = $2 AND kind = 'person'
       AND (owner_member_id IS NULL OR owner_member_id = $3)
     LIMIT 1`,
    [entityId, principal.householdId, principal.memberId],
  );
  if (!result.rows[0]) throw new PersonLinkValidationError("person_not_found");
}

async function moveIdentity(
  householdId: string,
  identityId: string,
  targetEntityId: string,
): Promise<{ identityId: string; personEntityId: string; previousPersonEntityId?: string }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const identityResult = await client.query<{
      id: string;
      external_value: string;
      label: string | null;
      current_entity_id: string | null;
    }>(
      `SELECT i.id, i.external_value, i.label, l.entity_id AS current_entity_id
       FROM identities i
       LEFT JOIN identity_entity_links l ON l.identity_id = i.id
       WHERE i.id = $1 AND i.household_id = $2
       FOR UPDATE OF i`,
      [identityId, householdId],
    );
    const identity = identityResult.rows[0];
    if (!identity) throw new PersonLinkValidationError("identity_not_found");

    const targetResult = await client.query<{ id: string }>(
      `SELECT id FROM entities
       WHERE id = $1 AND household_id = $2 AND kind = 'person'
       FOR UPDATE`,
      [targetEntityId, householdId],
    );
    if (!targetResult.rows[0]) throw new PersonLinkValidationError("person_not_found");

    const previousPersonEntityId = identity.current_entity_id ?? undefined;
    if (previousPersonEntityId !== targetEntityId) {
      await client.query(
        `INSERT INTO identity_entity_links(identity_id, entity_id)
         VALUES ($1, $2)
         ON CONFLICT(identity_id) DO UPDATE SET entity_id = EXCLUDED.entity_id`,
        [identityId, targetEntityId],
      );
      await client.query(
        `UPDATE plugin_identity_bindings
         SET entity_id = $3, updated_at = now()
         WHERE household_id = $1 AND identity_id = $2`,
        [householdId, identityId, targetEntityId],
      );
      await client.query(
        `INSERT INTO entity_aliases(entity_id, alias, normalized_alias, source)
         VALUES ($1, $2, lower($2), 'identity_link')
         ON CONFLICT(entity_id, alias) DO NOTHING`,
        [targetEntityId, identity.external_value],
      );
      if (identity.label?.trim()) {
        await client.query(
          `INSERT INTO entity_aliases(entity_id, alias, normalized_alias, source)
           VALUES ($1, $2, lower($2), 'identity_link')
           ON CONFLICT(entity_id, alias) DO NOTHING`,
          [targetEntityId, identity.label.trim()],
        );
      }
      await client.query(`UPDATE entities SET updated_at = now() WHERE id = $1`, [targetEntityId]);

      if (previousPersonEntityId) {
        const remaining = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM identity_entity_links WHERE entity_id = $1`,
          [previousPersonEntityId],
        );
        if (Number(remaining.rows[0]?.count ?? "0") === 0) {
          await client.query(
            `UPDATE entities
             SET metadata = metadata || jsonb_build_object('supersededBy', $2::text),
                 updated_at = now()
             WHERE id = $1 AND household_id = $3 AND kind = 'person'
               AND COALESCE(metadata->>'origin', '') IN ('identity', 'plugin_identity')`,
            [previousPersonEntityId, targetEntityId, householdId],
          );
        }
      }
    }

    await client.query("COMMIT");
    return { identityId, personEntityId: targetEntityId, ...(previousPersonEntityId ? { previousPersonEntityId } : {}) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function linkIdentityToCanonicalPerson(
  principal: AuthPrincipal,
  identityIdRaw: string,
  personEntityIdRaw: string,
): Promise<{ identityId: string; personEntityId: string; previousPersonEntityId?: string }> {
  if (!canManagePeople(principal)) throw new PersonLinkValidationError("person_link_forbidden");
  const identityId = requireUuid(identityIdRaw, "identity_id");
  const personEntityId = requireUuid(personEntityIdRaw, "person_entity_id");
  await assertUserVisibleTarget(principal, personEntityId);
  return moveIdentity(principal.householdId, identityId, personEntityId);
}

export async function linkPluginIdentityToCanonicalPerson(
  principal: SolPluginRuntimePrincipal,
  identityIdRaw: string,
  personEntityIdRaw: string,
): Promise<{ identityId: string; personEntityId: string; previousPersonEntityId?: string }> {
  const identityId = requireUuid(identityIdRaw, "identity_id");
  const personEntityId = requireUuid(personEntityIdRaw, "person_entity_id");
  await assertPluginVisibleTarget(principal, personEntityId);
  const owned = await db.query<{ identity_id: string }>(
    `SELECT identity_id
     FROM plugin_identity_bindings
     WHERE household_id = $1 AND plugin_id = $2 AND identity_id = $3
     LIMIT 1`,
    [principal.householdId, principal.pluginId, identityId],
  );
  if (!owned.rows[0]) throw new PersonLinkValidationError("identity_not_owned_by_plugin");
  return moveIdentity(principal.householdId, identityId, personEntityId);
}
