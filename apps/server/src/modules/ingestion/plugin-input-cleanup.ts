import { db } from "../../database/client.js";
import type { SolPluginRuntimePrincipal } from "../plugins/types.js";

function pluginAuthMode(pluginId: string): string {
  return `plugin:${pluginId}`;
}

/**
 * Removes the SOL projection of an input after the owning plugin has removed
 * the real external account. source_items, conversations and cursors cascade
 * from source_accounts, so no orphan ingestion state remains.
 */
export async function unregisterPluginInput(
  principal: SolPluginRuntimePrincipal,
  sourceAccountId: string,
): Promise<boolean> {
  const result = await db.query<{
    id: string;
    owner_member_id: string | null;
    auth_mode: string | null;
  }>(
    `SELECT id, owner_member_id, auth_mode
     FROM source_accounts
     WHERE id=$1 AND household_id=$2
     LIMIT 1`,
    [sourceAccountId, principal.householdId],
  );
  const row = result.rows[0];
  if (
    !row ||
    row.owner_member_id !== principal.memberId ||
    row.auth_mode !== pluginAuthMode(principal.pluginId)
  ) {
    throw new Error("plugin_input_not_found");
  }
  const deleted = await db.query(
    `DELETE FROM source_accounts
     WHERE id=$1 AND household_id=$2`,
    [sourceAccountId, principal.householdId],
  );
  return Boolean(deleted.rowCount);
}
