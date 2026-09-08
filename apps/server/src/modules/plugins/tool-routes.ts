import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "../../http.js";
import { pluginManager } from "./runtime.js";
import { pluginToolRuntime } from "./tool-runtime.js";
import { upsertPluginPersonIdentity } from "./identity-service.js";

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
  const legacy = path === "/v1/plugin-api/mcp/tools/register";
  const isToolRoute = legacy || path.startsWith("/v1/plugin-api/tools");
  const isIdentityRoute = path.startsWith("/v1/plugin-api/identities");
  if (!isToolRoute && !isIdentityRoute) return false;

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

  if (isIdentityRoute) {
    if (path !== "/v1/plugin-api/identities/person") {
      sendJson(response, 404, { error: "plugin_identity_route_not_found" });
      return true;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!principal.permissions.includes("identity.write")) {
      sendJson(response, 403, { error: "plugin_permission_required", permission: "identity.write" });
      return true;
    }
    if (!request.headers["content-type"]?.includes("application/json")) {
      sendJson(response, 415, { error: "content_type_must_be_application_json" });
      return true;
    }
    try {
      const body = await readJsonBody<{
        externalId?: unknown;
        label?: unknown;
        metadata?: unknown;
        autoLinkMember?: unknown;
      }>(request);
      const person = await upsertPluginPersonIdentity(principal, body);
      sendJson(response, 200, { ok: true, person });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  const permission = legacy ? "mcp.register" : "tool.register";
  if (!principal.permissions.includes(permission)) {
    sendJson(response, 403, { error: "plugin_permission_required", permission });
    return true;
  }
  if (!legacy && path !== "/v1/plugin-api/tools/register") {
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
    const tools = await pluginToolRuntime.register(principal, token, body, legacy);
    sendJson(response, 200, { ok: true, pluginId: principal.pluginId, tools });
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
