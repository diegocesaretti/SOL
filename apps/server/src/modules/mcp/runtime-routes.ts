import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "../../http.js";
import { authenticateMcpAccess } from "./access.js";
import { pluginToolRuntime } from "../plugins/tool-runtime.js";

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization?.trim();
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

export async function handleMcpRuntimeApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  if (!path.startsWith("/v1/mcp/runtime/")) return false;
  const token = bearerToken(request);
  if (!token) {
    sendJson(response, 401, { error: "mcp_token_required" });
    return true;
  }
  const access = await authenticateMcpAccess(token);
  if (!access) {
    sendJson(response, 401, { error: "mcp_token_invalid" });
    return true;
  }
  const allowExternalActions = access.scopes.includes("external_action");
  const scope = { householdId: access.principal.householdId, memberId: access.principal.memberId };

  if (path === "/v1/mcp/runtime/tools" && request.method === "GET") {
    sendJson(response, 200, { tools: await pluginToolRuntime.list(scope, allowExternalActions) });
    return true;
  }

  const match = path.match(/^\/v1\/mcp\/runtime\/tools\/([^/]+)\/call$/);
  if (match && request.method === "POST") {
    if (!request.headers["content-type"]?.includes("application/json")) {
      sendJson(response, 415, { error: "content_type_must_be_application_json" });
      return true;
    }
    try {
      const input = await readJsonBody<unknown>(request);
      const name = decodeURIComponent(match[1]!);
      const result = await pluginToolRuntime.execute(scope, allowExternalActions, name, input);
      sendJson(response, 200, { result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === "plugin_tool_not_found"
        ? 404
        : message === "mcp_external_action_scope_required"
          ? 403
          : 400;
      sendJson(response, status, { error: message });
    }
    return true;
  }

  sendJson(response, 404, { error: "mcp_runtime_route_not_found" });
  return true;
}
