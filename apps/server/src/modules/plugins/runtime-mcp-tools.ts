import { db } from "../../database/client.js";
import type { SolPluginRuntimePrincipal } from "./types.js";

const TOOL_RE = /^[a-z][a-z0-9_]{1,79}$/;
export type RuntimeMcpScope = "read" | "actions";

export interface RuntimeMcpToolDescriptor {
  pluginId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiredScope: RuntimeMcpScope;
  visibility: "private" | "family";
}

function loopbackCallbackUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("plugin_tool_callback_invalid"); }
  if (url.protocol !== "http:") throw new Error("plugin_tool_callback_invalid");
  const host = url.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && host !== "[::1]") throw new Error("plugin_tool_callback_invalid");
  if (url.username || url.password || url.hash) throw new Error("plugin_tool_callback_invalid");
  return url;
}

function toolName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!TOOL_RE.test(name)) throw new Error("plugin_tool_name_invalid");
  return name;
}

function toolArguments(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("plugin_tool_arguments_invalid");
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > 64 * 1024) throw new Error("plugin_tool_arguments_too_large");
  return value as Record<string, unknown>;
}

export async function listPluginRuntimeTools(principal: SolPluginRuntimePrincipal, scopes: RuntimeMcpScope[]): Promise<RuntimeMcpToolDescriptor[]> {
  if (!scopes.length) return [];
  const result = await db.query<{
    plugin_id: string;
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
    required_scope: RuntimeMcpScope;
    visibility: "private" | "family";
  }>(
    `SELECT plugin_id, name, description, input_schema, required_scope, visibility::text
     FROM plugin_mcp_tools
     WHERE household_id = $1
       AND required_scope = ANY($2::text[])
       AND (visibility = 'family' OR owner_member_id = $3)
       AND plugin_id <> $4
     ORDER BY plugin_id, name`,
    [principal.householdId, scopes, principal.memberId, principal.pluginId],
  );
  return result.rows.map((row) => ({
    pluginId: row.plugin_id,
    name: row.name,
    description: row.description,
    inputSchema: row.input_schema,
    requiredScope: row.required_scope,
    visibility: row.visibility,
  }));
}

export async function invokePluginRuntimeTool(principal: SolPluginRuntimePrincipal, scope: RuntimeMcpScope, input: { name?: unknown; arguments?: unknown }): Promise<unknown> {
  const name = toolName(input.name);
  const args = toolArguments(input.arguments);
  const result = await db.query<{ plugin_id: string; callback_url: string }>(
    `SELECT plugin_id, callback_url
     FROM plugin_mcp_tools
     WHERE household_id = $1
       AND name = $2
       AND required_scope = $3
       AND (visibility = 'family' OR owner_member_id = $4)
       AND plugin_id <> $5
     LIMIT 1`,
    [principal.householdId, name, scope, principal.memberId, principal.pluginId],
  );
  const tool = result.rows[0];
  if (!tool) throw new Error(`plugin_${scope}_tool_not_found`);

  const response = await fetch(loopbackCallbackUrl(tool.callback_url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "sol.plugin.mcp.invoke",
      pluginId: tool.plugin_id,
      tool: name,
      arguments: args,
      caller: {
        kind: "plugin",
        pluginId: principal.pluginId,
        householdId: principal.householdId,
        memberId: principal.memberId,
      },
    }),
    signal: AbortSignal.timeout(scope === "actions" ? 15_000 : 10_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error?: unknown }).error || `HTTP ${response.status}`)
      : `HTTP ${response.status}`;
    throw new Error(`plugin_${scope}_tool_failed:${tool.plugin_id}:${name}:${detail}`);
  }
  return payload;
}
