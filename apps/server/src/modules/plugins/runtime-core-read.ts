import { db } from "../../database/client.js";
import type { AuthPrincipal } from "../auth/session.js";
import { searchMcpWhatsapp } from "../mcp/whatsapp.js";
import type { SolPluginRuntimePrincipal } from "./types.js";

async function memberPrincipal(principal: SolPluginRuntimePrincipal): Promise<AuthPrincipal> {
  const result = await db.query<{
    household_id: string;
    member_id: string;
    display_name: string;
    login_name: string;
    role: AuthPrincipal["role"];
  }>(
    `SELECT m.household_id,
            m.id AS member_id,
            m.display_name,
            m.login_name,
            m.role::text AS role
       FROM members m
      WHERE m.household_id = $1
        AND m.id = $2
        AND m.status = 'active'
      LIMIT 1`,
    [principal.householdId, principal.memberId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("plugin_member_not_found");
  return {
    householdId: row.household_id,
    memberId: row.member_id,
    displayName: row.display_name,
    loginName: row.login_name,
    role: row.role,
  };
}

export async function searchPluginRuntimeWhatsapp(
  principal: SolPluginRuntimePrincipal,
  input: { query?: unknown; limit?: unknown },
): Promise<Array<Record<string, unknown>>> {
  const query = typeof input.query === "string" ? input.query.trim().slice(0, 240) : "";
  if (query.length < 2) throw new Error("whatsapp_search_query_invalid");
  const rawLimit = typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : 30;
  const limit = Math.max(1, Math.min(80, Math.trunc(rawLimit)));
  return await searchMcpWhatsapp(await memberPrincipal(principal), query, limit);
}
