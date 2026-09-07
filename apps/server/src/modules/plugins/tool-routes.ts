import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "../../http.js";
import { pluginManager } from "./runtime.js";
import { pluginToolRuntime } from "./tool-runtime.js";

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization?.trim();
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

export async function handlePluginToolApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  if (!path.startsWith("/v1/plugin-api/tools")) return false;
  const token = bearerToken(request);
  if (!token) {
    sendJson(response, 401, { error: "plugin_token_required" });
    return true;
  }
  const principal = await pluginManager.authenticateRuntimeToken(token);
  if (!principal) {
    sendJson(response, 401, { error: "plugin_token_invalid" });
    return true;
  }
  if (!principal.permissions.includes("tool.register")) {
    sendJson(response, 403, { error: "plugin_permission_required", permission: "tool.register" });
    return true;
  }
  if (path !== "/v1/plugin-api/tools/register") {
    sendJson(response, 404, { error: "plugin_tool_route_not_found" });
    return true;
  }
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "method_not_allowed" });
    return true;
  }
  if (!request.headers["content-type"]?.includes("application/json")) {
    sendJson(response, 415, { error: "content_type_must_be_application_json" });
    return true;
  }
  try {
    const body = await readJsonBody<unknown>(request);
    const tools = await pluginToolRuntime.register(principal, token, body);
    sendJson(response, 200, { ok: true, pluginId: principal.pluginId, tools });
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
