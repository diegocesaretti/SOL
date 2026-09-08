import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "../../http.js";
import type { SolPluginRuntimePrincipal } from "../plugins/types.js";
import {
  getOAuthFlow,
  listOAuthProviders,
  startOAuthFlow,
  upsertOAuthProvider,
} from "./service.js";

function requirePermission(
  response: ServerResponse,
  principal: SolPluginRuntimePrincipal,
): boolean {
  if (principal.permissions.includes("oauth.manage")) return true;
  sendJson(response, 403, { error: "plugin_permission_required", permission: "oauth.manage" });
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

export async function handlePluginOAuthRuntime(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  principal: SolPluginRuntimePrincipal,
): Promise<boolean> {
  if (!path.startsWith("/v1/plugin-api/oauth/")) return false;
  if (!requirePermission(response, principal)) return true;

  if (path === "/v1/plugin-api/oauth/providers") {
    if (request.method === "GET") {
      try {
        sendJson(response, 200, { providers: await listOAuthProviders(principal) });
      } catch (error) {
        runtimeError(response, error);
      }
      return true;
    }
    if (request.method === "POST") {
      const input = await jsonBody<{
        provider?: unknown;
        authorizationUrl?: unknown;
        tokenUrl?: unknown;
        redirectUri?: unknown;
        clientId?: unknown;
        clientAuth?: unknown;
        clientSecretCredentialId?: unknown;
        defaultScopes?: unknown;
      }>(request, response);
      if (!input) return true;
      try {
        sendJson(response, 200, { provider: await upsertOAuthProvider(principal, input) });
      } catch (error) {
        runtimeError(response, error);
      }
      return true;
    }
    sendJson(response, 405, { error: "method_not_allowed" });
    return true;
  }

  if (path === "/v1/plugin-api/oauth/flows") {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    const input = await jsonBody<{ provider?: unknown; scopes?: unknown; connectionId?: unknown }>(request, response);
    if (!input) return true;
    try {
      sendJson(response, 201, await startOAuthFlow(principal, input));
    } catch (error) {
      runtimeError(response, error);
    }
    return true;
  }

  const flowMatch = path.match(/^\/v1\/plugin-api\/oauth\/flows\/([0-9a-f-]{36})$/i);
  if (flowMatch) {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    try {
      sendJson(response, 200, { flow: await getOAuthFlow(principal, flowMatch[1]!) });
    } catch (error) {
      runtimeError(response, error);
    }
    return true;
  }

  sendJson(response, 404, { error: "oauth_route_not_found" });
  return true;
}
