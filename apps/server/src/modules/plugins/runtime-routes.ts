import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "../../http.js";
import { handlePluginConnectionsApi } from "../connections/runtime.js";
import { handlePluginCredentialRuntime } from "../credentials/runtime.js";
import { upsertPluginPersonIdentity } from "./identity-service.js";
import { getPluginVisiblePerson, listPluginVisiblePeople } from "./identity-read-service.js";
import { registerPluginMcpTools } from "./mcp-registry.js";
import { invokePluginReadTool } from "./runtime-mcp-read.js";
import { pluginManager } from "./runtime.js";
import type { SolPluginRuntimePrincipal } from "./types.js";

function bearerToken(request: IncomingMessage): string | undefined {
  const match = request.headers.authorization?.trim().match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

async function authenticate(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<SolPluginRuntimePrincipal | null> {
  const token = bearerToken(request);
  if (!token) {
    sendJson(response, 401, { error: "plugin_token_required" });
    return null;
  }
  const principal = await pluginManager.authenticateRuntimeToken(token);
  if (!principal) {
    sendJson(response, 401, { error: "plugin_token_invalid" });
    return null;
  }
  return principal;
}

function requirePermission(
  response: ServerResponse,
  principal: SolPluginRuntimePrincipal,
  permission: string,
): boolean {
  if (principal.permissions.includes(permission)) return true;
  sendJson(response, 403, { error: "plugin_permission_required", permission });
  return false;
}

async function jsonBody<T>(request: IncomingMessage, response: ServerResponse): Promise<T | null> {
  if (!request.headers["content-type"]?.includes("application/json")) {
    sendJson(response, 415, { error: "content_type_must_be_application_json" });
    return null;
  }
  try {
    return await readJsonBody<T>(request);
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid_json" });
    return null;
  }
}

function runtimeError(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  sendJson(response, message.endsWith("_not_found") ? 404 : 400, { error: message });
}

export async function handlePluginRuntimeApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const peopleMatch = path.match(/^\/v1\/plugin-api\/identities\/people(?:\/([0-9a-f-]{36}))?$/i);
  const connectionPath = path === "/v1/plugin-api/connections"
    || /^\/v1\/plugin-api\/connections\/[0-9a-f-]{36}$/i.test(path);
  const credentialPath = path.startsWith("/v1/plugin-api/credentials");
  if (
    path !== "/v1/plugin-api/identities/person"
    && path !== "/v1/plugin-api/mcp/tools/register"
    && path !== "/v1/plugin-api/mcp/tools/invoke-read"
    && !peopleMatch
    && !connectionPath
    && !credentialPath
  ) {
    return false;
  }
  const principal = await authenticate(request, response);
  if (!principal) return true;

  if (connectionPath) {
    return await handlePluginConnectionsApi(path, request, response, principal);
  }

  if (credentialPath) {
    return await handlePluginCredentialRuntime(path, request, response, principal);
  }

  if (peopleMatch && request.method === "GET") {
    if (!requirePermission(response, principal, "identity.read")) return true;
    try {
      const entityId = peopleMatch[1];
      if (entityId) {
        const person = await getPluginVisiblePerson(principal, entityId);
        if (!person) {
          sendJson(response, 404, { error: "person_not_found" });
          return true;
        }
        sendJson(response, 200, { person });
      } else {
        sendJson(response, 200, { people: await listPluginVisiblePeople(principal) });
      }
    } catch (error) {
      runtimeError(response, error);
    }
    return true;
  }

  if (path === "/v1/plugin-api/identities/person" && request.method === "POST") {
    if (!requirePermission(response, principal, "identity.write")) return true;
    const input = await jsonBody<{
      externalId?: unknown;
      label?: unknown;
      metadata?: unknown;
      autoLinkMember?: unknown;
    }>(request, response);
    if (!input) return true;
    try {
      sendJson(response, 200, { person: await upsertPluginPersonIdentity(principal, input) });
    } catch (error) {
      runtimeError(response, error);
    }
    return true;
  }

  if (path === "/v1/plugin-api/mcp/tools/register" && request.method === "POST") {
    if (!requirePermission(response, principal, "mcp.register")) return true;
    const input = await jsonBody<{ callbackUrl?: unknown; tools?: unknown }>(request, response);
    if (!input) return true;
    try {
      const tools = await registerPluginMcpTools(principal, input);
      sendJson(response, 200, { tools: tools.map(({ callbackUrl: _callbackUrl, ...tool }) => tool) });
    } catch (error) {
      runtimeError(response, error);
    }
    return true;
  }

  if (path === "/v1/plugin-api/mcp/tools/invoke-read" && request.method === "POST") {
    if (!requirePermission(response, principal, "mcp.invoke.read")) return true;
    const input = await jsonBody<{ name?: unknown; arguments?: unknown }>(request, response);
    if (!input) return true;
    try {
      sendJson(response, 200, await invokePluginReadTool(principal, input));
    } catch (error) {
      runtimeError(response, error);
    }
    return true;
  }

  sendJson(response, 405, { error: "method_not_allowed" });
  return true;
}
