import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "../../../http.js";
import type { AuthPrincipal } from "../../auth/session.js";
import { homeAssistantManager } from "./manager.js";
import {
  createHomeAssistantAccount,
  discoverHomeAssistantEntities,
  getHomeAssistantAccount,
  listHomeAssistantAccounts,
  listHomeAssistantEntities,
  listSelectedHomeAssistantEntities,
  updateHomeAssistantEntitySelection,
} from "./repository.js";

function canManage(principal: AuthPrincipal): boolean {
  return principal.role === "owner" || principal.role === "adult";
}

async function jsonBody<T>(request: IncomingMessage, response: ServerResponse): Promise<T | null> {
  if (!request.headers["content-type"]?.includes("application/json")) {
    sendJson(response, 415, { error: "content-type must be application/json" });
    return null;
  }
  try {
    return await readJsonBody<T>(request);
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid_request" });
    return null;
  }
}

async function accountFor(
  principal: AuthPrincipal,
  sourceAccountId: string,
  response: ServerResponse,
) {
  const account = await getHomeAssistantAccount(sourceAccountId);
  if (!account || account.householdId !== principal.householdId) {
    sendJson(response, 404, { error: "home_assistant_account_not_found" });
    return null;
  }
  return account;
}

export async function handleHomeAssistantApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthPrincipal,
): Promise<boolean> {
  if (!path.startsWith("/v1/home-assistant")) return false;
  if (principal.role === "guest") {
    sendJson(response, 403, { error: "forbidden" });
    return true;
  }

  if (path === "/v1/home-assistant/accounts" && request.method === "GET") {
    const accounts = await listHomeAssistantAccounts(principal.householdId);
    sendJson(response, 200, {
      accounts: accounts.map((account) => ({
        ...account,
        runtime: homeAssistantManager.getStatus(account.id),
        canManage: canManage(principal),
      })),
    });
    return true;
  }

  if (path === "/v1/home-assistant/accounts" && request.method === "POST") {
    if (!canManage(principal)) {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }
    const input = await jsonBody<{ label?: string; baseUrl?: string; token?: string }>(request, response);
    if (!input) return true;
    try {
      const account = await createHomeAssistantAccount({
        householdId: principal.householdId,
        label: input.label,
        baseUrl: input.baseUrl ?? "",
        token: input.token ?? "",
      });
      await homeAssistantManager.start(account.id);
      sendJson(response, 201, {
        account: { ...account, runtime: homeAssistantManager.getStatus(account.id) },
      });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  const match = path.match(/^\/v1\/home-assistant\/accounts\/([0-9a-f-]+)(?:\/(entities|discover|restart))?$/i);
  if (!match?.[1]) return false;
  const sourceAccountId = match[1];
  const action = match[2];
  const account = await accountFor(principal, sourceAccountId, response);
  if (!account) return true;

  if (!action && request.method === "GET") {
    sendJson(response, 200, {
      account: {
        ...account,
        runtime: homeAssistantManager.getStatus(sourceAccountId),
        canManage: canManage(principal),
      },
    });
    return true;
  }

  if (action === "entities" && request.method === "GET") {
    const entities = canManage(principal)
      ? await listHomeAssistantEntities(sourceAccountId)
      : await listSelectedHomeAssistantEntities(sourceAccountId);
    sendJson(response, 200, { entities });
    return true;
  }

  if (action === "entities" && request.method === "POST") {
    if (!canManage(principal)) {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }
    const input = await jsonBody<{
      entityId?: string;
      selectedForSync?: boolean;
      recordMode?: "snapshot" | "changes";
    }>(request, response);
    if (!input) return true;
    if (!input.entityId || typeof input.selectedForSync !== "boolean") {
      sendJson(response, 400, { error: "entityId and selectedForSync are required" });
      return true;
    }
    if (input.recordMode && input.recordMode !== "snapshot" && input.recordMode !== "changes") {
      sendJson(response, 400, { error: "recordMode must be snapshot or changes" });
      return true;
    }
    try {
      await updateHomeAssistantEntitySelection({
        sourceAccountId,
        entityId: input.entityId,
        selectedForSync: input.selectedForSync,
        recordMode: input.recordMode,
      });
      await homeAssistantManager.refreshSelections(sourceAccountId);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (action === "discover" && request.method === "POST") {
    if (!canManage(principal)) {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }
    try {
      const count = await discoverHomeAssistantEntities(sourceAccountId);
      await homeAssistantManager.refreshSelections(sourceAccountId);
      sendJson(response, 200, { ok: true, count });
    } catch (error) {
      sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (action === "restart" && request.method === "POST") {
    if (!canManage(principal)) {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }
    try {
      sendJson(response, 200, { runtime: await homeAssistantManager.restart(sourceAccountId) });
    } catch (error) {
      sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  return false;
}
