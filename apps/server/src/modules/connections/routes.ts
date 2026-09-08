import type { IncomingMessage, ServerResponse } from "node:http";
import { db } from "../../database/client.js";
import { sendJson } from "../../http.js";
import type { AuthPrincipal } from "../auth/session.js";

interface ConnectionRow {
  id: string;
  owner_member_id: string | null;
  plugin_id: string;
  provider: string;
  external_account_id: string;
  display_name: string;
  status: string;
  scopes: string[];
  metadata: Record<string, unknown>;
  last_sync_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function handleConnectionsApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthPrincipal,
): Promise<boolean> {
  if (path !== "/v1/connections") return false;
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "connections_are_plugin_managed" });
    return true;
  }

  const canReadHousehold = principal.role !== "guest";
  const result = await db.query<ConnectionRow>(
    `SELECT id, owner_member_id, plugin_id, provider, external_account_id, display_name,
            status, scopes, metadata, last_sync_at, last_error, created_at, updated_at
     FROM connections
     WHERE household_id = $1
       AND (owner_member_id = $2 OR ($3::boolean AND owner_member_id IS NULL))
     ORDER BY updated_at DESC, display_name, id`,
    [principal.householdId, principal.memberId, canReadHousehold],
  );

  sendJson(response, 200, {
    connections: result.rows.map((row) => ({
      id: row.id,
      ownerMemberId: row.owner_member_id,
      pluginId: row.plugin_id,
      provider: row.provider,
      externalAccountId: row.external_account_id,
      displayName: row.display_name,
      status: row.status,
      scopes: row.scopes ?? [],
      metadata: row.metadata ?? {},
      lastSyncAt: row.last_sync_at?.toISOString(),
      lastError: row.last_error ?? undefined,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    })),
  });
  return true;
}
