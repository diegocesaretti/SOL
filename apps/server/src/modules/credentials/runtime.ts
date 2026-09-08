import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "../../http.js";
import type { SolPluginRuntimePrincipal } from "../plugins/types.js";
import {
  createPluginCredential,
  deletePluginCredential,
  listPluginCredentials,
  resolvePluginCredential,
  updatePluginCredential,
} from "./service.js";

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

export async function handlePluginCredentialRuntime(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  principal: SolPluginRuntimePrincipal,
): Promise<boolean> {
  if (!path.startsWith("/v1/plugin-api/credentials")) return false;

  if (path === "/v1/plugin-api/credentials") {
    if (request.method === "GET") {
      if (!requirePermission(response, principal, "credentials.read")) return true;
      try {
        sendJson(response, 200, { credentials: await listPluginCredentials(principal) });
      } catch (error) {
        runtimeError(response, error);
      }
      return true;
    }
    if (request.method === "POST") {
      if (!requirePermission(response, principal, "credentials.write")) return true;
      const input = await jsonBody<{
        provider?: unknown;
        kind?: unknown;
        label?: unknown;
        secret?: unknown;
        metadata?: unknown;
        expiresAt?: unknown;
      }>(request, response);
      if (!input) return true;
      try {
        sendJson(response, 201, { credential: await createPluginCredential(principal, input) });
      } catch (error) {
        runtimeError(response, error);
      }
      return true;
    }
    sendJson(response, 405, { error: "method_not_allowed" });
    return true;
  }

  const resolveMatch = path.match(/^\/v1\/plugin-api\/credentials\/([0-9a-f-]{36})\/resolve$/i);
  if (resolveMatch) {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!requirePermission(response, principal, "credentials.read")) return true;
    try {
      sendJson(response, 200, await resolvePluginCredential(principal, resolveMatch[1]!));
    } catch (error) {
      runtimeError(response, error);
    }
    return true;
  }

  const match = path.match(/^\/v1\/plugin-api\/credentials\/([0-9a-f-]{36})$/i);
  if (!match) {
    sendJson(response, 404, { error: "credential_route_not_found" });
    return true;
  }
  const credentialId = match[1]!;

  if (request.method === "PATCH") {
    if (!requirePermission(response, principal, "credentials.write")) return true;
    const input = await jsonBody<{
      label?: unknown;
      secret?: unknown;
      metadata?: unknown;
      expiresAt?: unknown;
    }>(request, response);
    if (!input) return true;
    try {
      sendJson(response, 200, { credential: await updatePluginCredential(principal, credentialId, input) });
    } catch (error) {
      runtimeError(response, error);
    }
    return true;
  }

  if (request.method === "DELETE") {
    if (!requirePermission(response, principal, "credentials.write")) return true;
    try {
      sendJson(response, 200, { ok: await deletePluginCredential(principal, credentialId) });
    } catch (error) {
      runtimeError(response, error);
    }
    return true;
  }

  sendJson(response, 405, { error: "method_not_allowed" });
  return true;
}
