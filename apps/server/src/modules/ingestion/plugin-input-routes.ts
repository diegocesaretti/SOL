import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "../../http.js";
import { pluginManager } from "../plugins/runtime.js";
import {
  ingestPluginItem,
  registerPluginInput,
  updatePluginInputStatus,
} from "./plugin-input-service.js";
import type { SolPluginRuntimePrincipal } from "../plugins/types.js";

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization?.trim();
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
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

async function body<T>(request: IncomingMessage, response: ServerResponse): Promise<T | null> {
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

export function transientPluginInputDatabaseError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  return code === "40P01" || code === "40001";
}

function apiError(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (transientPluginInputDatabaseError(error)) {
    sendJson(response, 503, { error: "plugin_input_temporarily_unavailable", detail: message });
    return;
  }
  if (message === "plugin_input_not_found") {
    sendJson(response, 404, { error: message });
    return;
  }
  if (message === "input_account_owned_by_other_runtime") {
    sendJson(response, 409, { error: message });
    return;
  }
  sendJson(response, 400, { error: message });
}

export async function handlePluginInputApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  if (!path.startsWith("/v1/plugin-api/inputs")) return false;
  const principal = await authenticate(request, response);
  if (!principal) return true;

  if (path === "/v1/plugin-api/inputs/register" && request.method === "POST") {
    if (!requirePermission(response, principal, "input.register")) return true;
    const input = await body<{ provider?: unknown; externalAccountId?: unknown; label?: unknown }>(request, response);
    if (!input) return true;
    try {
      sendJson(response, 200, { input: await registerPluginInput(principal, input) });
    } catch (error) {
      apiError(response, error);
    }
    return true;
  }

  const match = path.match(/^\/v1\/plugin-api\/inputs\/([0-9a-f-]{36})\/(status|items)$/i);
  if (!match) {
    sendJson(response, 404, { error: "plugin_input_route_not_found" });
    return true;
  }
  const sourceAccountId = match[1]!;
  const action = match[2]!;

  if (action === "status" && request.method === "POST") {
    if (!requirePermission(response, principal, "input.status")) return true;
    const input = await body<{ status?: unknown; lastSyncAt?: unknown }>(request, response);
    if (!input) return true;
    try {
      sendJson(response, 200, { input: await updatePluginInputStatus(principal, sourceAccountId, input) });
    } catch (error) {
      apiError(response, error);
    }
    return true;
  }

  if (action === "items" && request.method === "POST") {
    if (!requirePermission(response, principal, "input.write")) return true;
    const input = await body<{
      externalId?: unknown;
      kind?: unknown;
      occurredAt?: unknown;
      observedAt?: unknown;
      title?: unknown;
      text?: unknown;
      metadata?: unknown;
      origin?: unknown;
    }>(request, response);
    if (!input) return true;
    try {
      sendJson(response, 200, { result: await ingestPluginItem(principal, sourceAccountId, input) });
    } catch (error) {
      apiError(response, error);
    }
    return true;
  }

  sendJson(response, 405, { error: "method_not_allowed" });
  return true;
}