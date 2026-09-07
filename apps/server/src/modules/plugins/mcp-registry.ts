import { db } from "../../database/client.js";
import type { AuthPrincipal } from "../auth/session.js";
import type { SolPluginRuntimePrincipal } from "./types.js";

const TOOL_RE = /^[a-z][a-z0-9_]{1,79}$/;

function callbackUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("callback_url_required");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("callback_url_invalid");
  }
  if (url.protocol !== "http:") throw new Error("plugin_mcp_callback_must_use_http_loopback");
  const host = url.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && host !== "[::1]") {
    throw new Error("plugin_mcp_callback_must_be_loopback");
  }
  if (url.username || url.password || url.hash) throw new Error("plugin_mcp_callback_url_not_allowed");
  return url.toString();
}

function schema(value: unknown): Record<string, unknown> {
  if (value === undefined) return { type: "object", properties: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("input_schema_must_be_object");
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > 48 * 1024) throw new Error("input_schema_too_large");
  return value as Record<string, unknown>;
}

export interface PluginMcpTool {
  pluginId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  callbackUrl: string;
  requiresSubmit: boolean;
  visibility: "private" | "family";
}

export async function registerPluginMcpTools(
  principal: SolPluginRuntimePrincipal,
  input: { callbackUrl?: unknown; tools?: unknown },
): Promise<PluginMcpTool[]> {
  const url = callbackUrl(input.callbackUrl);
  if (!Array.isArray(input.tools) || input.tools.length > 40) throw new Error("tools_must_be_array_with_at_most_40_items");
  const parsed = input.tools.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`tools_${index}_must_be_object`);
    const item = raw as Record<string, unknown>;
    const name = typeof item.name === "string" ? item.name.trim().toLowerCase() : "";
    if (!TOOL_RE.test(name)) throw new Error(`tools_${index}_name_invalid`);
    const description = typeof item.description === "string" ? item.description.trim() : "";
    if (!description || description.length > 1000) throw new Error(`tools_${index}_description_invalid`);
    const visibility = item.visibility === "private" ? "private" as const : "family" as const;
    return {
      pluginId: principal.pluginId,
      name,
      description,
      inputSchema: schema(item.inputSchema),
      callbackUrl: url,
      requiresSubmit: item.requiresSubmit === true,
      visibility,
    };
  });
  if (new Set(parsed.map((tool) => tool.name)).size !== parsed.length) throw new Error("duplicate_plugin_mcp_tool_name");

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const keep = parsed.map((tool) => tool.name);
    await client.query(
      `DELETE FROM plugin_mcp_tools
       WHERE household_id = $1 AND plugin_id = $2
         AND NOT (name = ANY($3::text[]))`,
      [principal.householdId, principal.pluginId, keep],
    );
    for (const tool of parsed) {
      await client.query(
        `INSERT INTO plugin_mcp_tools(
           household_id, plugin_id, name, description, input_schema,
           callback_url, requires_submit, owner_member_id, visibility
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::visibility_scope)
         ON CONFLICT(household_id, plugin_id, name)
         DO UPDATE SET
           description = EXCLUDED.description,
           input_schema = EXCLUDED.input_schema,
           callback_url = EXCLUDED.callback_url,
           requires_submit = EXCLUDED.requires_submit,
           owner_member_id = EXCLUDED.owner_member_id,
           visibility = EXCLUDED.visibility,
           updated_at = now()`,
        [
          principal.householdId,
          principal.pluginId,
          tool.name,
          tool.description,
          JSON.stringify(tool.inputSchema),
          tool.callbackUrl,
          tool.requiresSubmit,
          principal.memberId,
          tool.visibility,
        ],
      );
    }
    await client.query("COMMIT");
    return parsed;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listPluginMcpTools(
  principal: AuthPrincipal,
  scopes: string[],
): Promise<PluginMcpTool[]> {
  const result = await db.query<{
    plugin_id: string;
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
    callback_url: string;
    requires_submit: boolean;
    visibility: "private" | "family";
  }>(
    `SELECT plugin_id, name, description, input_schema, callback_url,
            requires_submit, visibility::text
     FROM plugin_mcp_tools
     WHERE household_id = $1
       AND (visibility = 'family' OR owner_member_id = $2)
       AND (NOT requires_submit OR $3::boolean)
     ORDER BY plugin_id, name`,
    [principal.householdId, principal.memberId, scopes.includes("submit")],
  );
  return result.rows.map((row) => ({
    pluginId: row.plugin_id,
    name: row.name,
    description: row.description,
    inputSchema: row.input_schema,
    callbackUrl: row.callback_url,
    requiresSubmit: row.requires_submit,
    visibility: row.visibility,
  }));
}

export async function invokePluginMcpTool(
  principal: AuthPrincipal,
  tool: PluginMcpTool,
  args: Record<string, unknown>,
): Promise<unknown> {
  const url = callbackUrl(tool.callbackUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tool: tool.name,
      arguments: args,
      caller: {
        householdId: principal.householdId,
        memberId: principal.memberId,
        displayName: principal.displayName,
        role: principal.role,
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error?: unknown }).error || `HTTP ${response.status}`)
      : `HTTP ${response.status}`;
    throw new Error(`Plugin ${tool.pluginId} tool ${tool.name}: ${reason}`);
  }
  return payload;
}
