import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "../../http.js";
import type { SolPluginRuntimePrincipal } from "../plugins/types.js";
import {
  deletePluginConnection,
  listPluginConnections,
  updatePluginConnection,
  upsertPluginConnection,
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

function errorResponse(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  sendJson(response, message === "connection_not_found" ? 404 : 400, { error: message });
}

export async function handlePluginConnectionsApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  principal: SolPluginRuntimePrincipal,
): Promise<boolean> {
  const collection = path === "/v1/plugin-api/connections";
  const itemMatch = path.match(/^\/v1\/plugin-api\/connections\/([0-9a-f-]{36})$/i);
  if (!collection && !itemMatch) return false;

  if (collection && request.method === "GET") {
    if (!requirePermission(response, principal, "connections.read")) return true;
    try {
      sendJson(response, 200, { connections: await listPluginConnections(principal) });
    } catch (error) {
      errorResponse(response, error);
    }
    return true;
  }

  if (collection && request.method === "POST") {
    if (!requirePermission(response, principal, "connections.write")) return true;
    const input = await jsonBody<{
      provider?: unknown;
      externalAccountId?: unknown;
      displayName?: unknown;
      status?: unknown;
      scopes?: unknown;
      metadata?: unknown;
      lastSyncAt?: unknown;
      lastError?: unknown;
    }>(request, response);
    if (!input) return true;
    try {
      sendJson(response, 200, { connection: await upsertPluginConnection(principal, input) });
    } catch (error) {
      errorResponse(response, error);
    }
    return true;
  }

  if (itemMatch && request.method === "PATCH") {
    if (!requirePermission(response, principal, "connections.write")) return true;
    const input = await jsonBody<{
      displayName?: unknown;
      status?: unknown;
      scopes?: unknown;
      metadata?: unknown;
      lastSyncAt?: unknown;
      lastError?: unknown;
    }>(request, response);
    if (!input) return true;
    try {
      sendJson(response, 200, { connection: await updatePluginConnection(principal, itemMatch[1]!, input) });
    } catch (error) {
      errorResponse(response, error);
    }
    return true;
  }

  if (itemMatch && request.method === "DELETE") {
    if (!requirePermission(response, principal, "connections.write")) return true;
    try {
      sendJson(response, 200, { ok: await deletePluginConnection(principal, itemMatch[1]!) });
    } catch (error) {
      errorResponse(response, error);
    }
    return true;
  }

  sendJson(response, 405, { error: "method_not_allowed" });
  return true;
}
