import { db } from "../../database/client.js";
import type { SolPluginRuntimePrincipal } from "./types.js";

function text(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name}_required`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${name}_too_long`);
  return normalized;
}

function metadata(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("metadata_must_be_object");
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > 32 * 1024) throw new Error("metadata_too_large");
  return value as Record<string, unknown>;
}

export interface PluginPersonIdentityResult {
  identityId: string;
  entityId: string;
  externalId: string;
  label: string;
  linkedMemberId?: string;
  linkedBy: "existing" | "unique-name" | "none";
}

export async function upsertPluginPersonIdentity(
  principal: SolPluginRuntimePrincipal,
  input: {
    externalId?: unknown;
    label?: unknown;
    metadata?: unknown;
    autoLinkMember?: unknown;
  },
): Promise<PluginPersonIdentityResult> {
  const externalId = text(input.externalId, "external_id", 240);
  const label = text(input.label, "label", 180);
  const extra = metadata(input.metadata);
  const autoLinkMember = input.autoLinkMember === true;
  const provider = `plugin:${principal.pluginId}`;
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const identityResult = await client.query<{
      id: string;
      member_id: string | null;
    }>(
      `INSERT INTO identities(
         household_id, member_id, kind, provider, external_value, normalized_value, label, metadata
       ) VALUES ($1, NULL, 'plugin_person', $2, $3, lower($3), $4, $5::jsonb)
       ON CONFLICT(household_id, kind, provider, external_value)
       DO UPDATE SET
         label = EXCLUDED.label,
         normalized_value = EXCLUDED.normalized_value,
         metadata = identities.metadata || EXCLUDED.metadata
       RETURNING id, member_id`,
      [
        principal.householdId,
        provider,
        externalId,
        label,
        JSON.stringify({
          ...extra,
          pluginId: principal.pluginId,
          externalId,
          source: "plugin",
        }),
      ],
    );
    const identity = identityResult.rows[0];
    if (!identity) throw new Error("plugin_identity_upsert_failed");

    let linkedMemberId = identity.member_id ?? undefined;
    let linkedBy: PluginPersonIdentityResult["linkedBy"] = linkedMemberId ? "existing" : "none";
    if (!linkedMemberId && autoLinkMember) {
      const matches = await client.query<{ id: string }>(
        `SELECT id
         FROM members
         WHERE household_id = $1
           AND status = 'active'
           AND lower(btrim(display_name)) = lower(btrim($2))
         ORDER BY created_at ASC
         LIMIT 2`,
        [principal.householdId, label],
      );
      if (matches.rows.length === 1) {
        linkedMemberId = matches.rows[0]!.id;
        linkedBy = "unique-name";
        await client.query(
          `UPDATE identities SET member_id = $2 WHERE id = $1 AND member_id IS NULL`,
          [identity.id, linkedMemberId],
        );
      }
    }

    let entityId: string | undefined;
    const existingLink = await client.query<{ entity_id: string }>(
      `SELECT entity_id FROM identity_entity_links WHERE identity_id = $1 LIMIT 1`,
      [identity.id],
    );
    entityId = existingLink.rows[0]?.entity_id;

    if (!entityId) {
      const created = await client.query<{ id: string }>(
        `INSERT INTO entities(
           household_id, kind, canonical_name, owner_member_id, visibility, metadata
         ) VALUES ($1, 'person', $2, $3, $4::visibility_scope, $5::jsonb)
         RETURNING id`,
        [
          principal.householdId,
          label,
          linkedMemberId ?? null,
          linkedMemberId ? "private" : "family",
          JSON.stringify({
            origin: "plugin_identity",
            pluginId: principal.pluginId,
            identityId: identity.id,
            externalId,
          }),
        ],
      );
      entityId = created.rows[0]?.id;
      if (!entityId) throw new Error("plugin_person_entity_create_failed");
      await client.query(
        `INSERT INTO identity_entity_links(identity_id, entity_id)
         VALUES ($1, $2)
         ON CONFLICT(identity_id) DO NOTHING`,
        [identity.id, entityId],
      );
    } else {
      await client.query(
        `UPDATE entities
         SET canonical_name = $2,
             owner_member_id = $3,
             visibility = $4::visibility_scope,
             metadata = metadata || $5::jsonb,
             updated_at = now()
         WHERE id = $1 AND household_id = $6`,
        [
          entityId,
          label,
          linkedMemberId ?? null,
          linkedMemberId ? "private" : "family",
          JSON.stringify({ pluginId: principal.pluginId, identityId: identity.id, externalId }),
          principal.householdId,
        ],
      );
    }

    await client.query(
      `INSERT INTO entity_aliases(entity_id, alias, normalized_alias, source)
       VALUES ($1, $2, lower($2), $3)
       ON CONFLICT(entity_id, alias) DO NOTHING`,
      [entityId, externalId, `plugin:${principal.pluginId}`],
    );
    if (label !== externalId) {
      await client.query(
        `INSERT INTO entity_aliases(entity_id, alias, normalized_alias, source)
         VALUES ($1, $2, lower($2), $3)
         ON CONFLICT(entity_id, alias) DO NOTHING`,
        [entityId, label, `plugin:${principal.pluginId}`],
      );
    }

    await client.query(
      `INSERT INTO plugin_identity_bindings(
         household_id, plugin_id, external_id, identity_id, entity_id
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT(household_id, plugin_id, external_id)
       DO UPDATE SET identity_id = EXCLUDED.identity_id,
                     entity_id = EXCLUDED.entity_id,
                     updated_at = now()`,
      [principal.householdId, principal.pluginId, externalId, identity.id, entityId],
    );

    await client.query("COMMIT");
    return {
      identityId: identity.id,
      entityId,
      externalId,
      label,
      linkedMemberId,
      linkedBy,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
