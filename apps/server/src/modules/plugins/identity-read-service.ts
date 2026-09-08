import { db } from "../../database/client.js";
import type { SolPluginRuntimePrincipal } from "./types.js";

export interface PluginVisiblePerson {
  entityId: string;
  name: string;
  linkedToSolMember: boolean;
  source?: string;
  sourcePluginId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function rowToPerson(row: {
  id: string;
  canonical_name: string;
  linked_to_member: boolean;
  source: string | null;
  source_plugin_id: string | null;
}): PluginVisiblePerson {
  return {
    entityId: row.id,
    name: row.canonical_name,
    linkedToSolMember: row.linked_to_member,
    ...(row.source ? { source: row.source } : {}),
    ...(row.source_plugin_id ? { sourcePluginId: row.source_plugin_id } : {}),
  };
}

const PERSON_SELECT = `
  SELECT id,
         canonical_name,
         (owner_member_id IS NOT NULL) AS linked_to_member,
         metadata->>'origin' AS source,
         metadata->>'pluginId' AS source_plugin_id
  FROM entities
  WHERE household_id = $1
    AND kind = 'person'
    AND COALESCE(metadata->>'supersededBy', '') = ''
    AND (owner_member_id IS NULL OR owner_member_id = $2)
`;

/**
 * Return only canonical Person entities that are safe for the installing plugin
 * principal to see: family/external people (owner_member_id IS NULL) plus the
 * installing member's own private Person. A Person is an identity entity; this
 * API deliberately exposes no account credentials, roles or access grants.
 */
export async function listPluginVisiblePeople(
  principal: SolPluginRuntimePrincipal,
): Promise<PluginVisiblePerson[]> {
  const result = await db.query<{
    id: string;
    canonical_name: string;
    linked_to_member: boolean;
    source: string | null;
    source_plugin_id: string | null;
  }>(
    `${PERSON_SELECT}
     ORDER BY lower(canonical_name), id
     LIMIT 500`,
    [principal.householdId, principal.memberId],
  );
  return result.rows.map(rowToPerson);
}

export async function getPluginVisiblePerson(
  principal: SolPluginRuntimePrincipal,
  entityId: string,
): Promise<PluginVisiblePerson | null> {
  if (!UUID_RE.test(entityId)) return null;
  const result = await db.query<{
    id: string;
    canonical_name: string;
    linked_to_member: boolean;
    source: string | null;
    source_plugin_id: string | null;
  }>(
    `${PERSON_SELECT}
       AND id = $3
     LIMIT 1`,
    [principal.householdId, principal.memberId, entityId],
  );
  return result.rows[0] ? rowToPerson(result.rows[0]) : null;
}
