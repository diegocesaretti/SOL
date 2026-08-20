import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "../../../http.js";
import type { AuthPrincipal } from "../../auth/session.js";
import { createSourceAccount } from "../../identity/source-accounts.js";
import {
  clearMercadoLibreOAuth,
  completeMercadoLibreOAuth,
  mercadoLibreConfigured,
  startMercadoLibreOAuth,
} from "./oauth.js";
import {
  getMercadoLibreAccount,
  getMercadoLibreDashboard,
  listMercadoLibreAccounts,
  markMercadoLibreDisconnected,
  type MercadoLibreAccount,
} from "./repository.js";
import { syncMercadoLibreAccount } from "./sync.js";

async function readJson<T>(request: IncomingMessage, response: ServerResponse): Promise<T | null> {
  if (!request.headers["content-type"]?.includes("application/json")) {
    sendJson(response, 415, { error: "content-type must be application/json" });
    return null;
  }
  try {
    return await readJsonBody<T>(request);
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid request body" });
    return null;
  }
}

function adult(principal: AuthPrincipal): boolean {
  return principal.role === "owner" || principal.role === "adult";
}

function canManage(principal: AuthPrincipal, account: MercadoLibreAccount): boolean {
  if (principal.householdId !== account.householdId) return false;
  if (account.ownerMemberId) return account.ownerMemberId === principal.memberId;
  return adult(principal);
}

function canRead(principal: AuthPrincipal, account: MercadoLibreAccount): boolean {
  if (principal.householdId !== account.householdId) return false;
  if (account.ownerMemberId) return account.ownerMemberId === principal.memberId;
  return principal.role !== "guest";
}

function publicAccount(principal: AuthPrincipal, account: MercadoLibreAccount) {
  return { ...account, canManage: canManage(principal, account), canRead: canRead(principal, account) };
}

export async function handleMercadoLibreOAuthCallback(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://sol.local");
  if (request.method !== "GET" || url.pathname !== "/v1/mercadolibre/callback") return false;

  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    response.statusCode = 302;
    response.setHeader("location", `/mercadolibre?error=${encodeURIComponent(oauthError)}`);
    response.end();
    return true;
  }
  if (!state || !code) {
    sendJson(response, 400, { error: "missing_mercadolibre_oauth_callback_parameters" });
    return true;
  }

  try {
    const completed = await completeMercadoLibreOAuth(state, code);
    void syncMercadoLibreAccount(completed.sourceAccountId).catch((error) =>
      console.error(`[mercadolibre:${completed.sourceAccountId}] initial sync failed`, error),
    );
    const separator = completed.redirectAfter.includes("?") ? "&" : "?";
    response.statusCode = 302;
    response.setHeader("location", `${completed.redirectAfter}${separator}connected=1`);
    response.end();
  } catch (error) {
    response.statusCode = 302;
    response.setHeader(
      "location",
      `/mercadolibre?error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`,
    );
    response.end();
  }
  return true;
}

export async function handleMercadoLibreApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthPrincipal,
): Promise<boolean> {
  if (path === "/v1/mercadolibre/status" && request.method === "GET") {
    sendJson(response, 200, { configured: mercadoLibreConfigured(), httpsRedirectRequired: true });
    return true;
  }

  if (path === "/v1/mercadolibre/accounts" && request.method === "GET") {
    const accounts = await listMercadoLibreAccounts(
      principal.householdId,
      principal.memberId,
      adult(principal),
    );
    sendJson(response, 200, { accounts: accounts.map((account) => publicAccount(principal, account)) });
    return true;
  }

  if (path === "/v1/mercadolibre/accounts" && request.method === "POST") {
    if (principal.role === "child" || principal.role === "guest") {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }
    if (!mercadoLibreConfigured()) {
      sendJson(response, 503, { error: "mercadolibre_not_configured_https_callback_required" });
      return true;
    }
    const body = await readJson<{ label?: string; shared?: boolean }>(request, response);
    if (!body) return true;
    const shared = body.shared === true;
    if (shared && !adult(principal)) {
      sendJson(response, 403, { error: "shared_account_requires_adult_manager" });
      return true;
    }
    const sourceAccount = await createSourceAccount({
      householdId: principal.householdId,
      ownerMemberId: shared ? undefined : principal.memberId,
      provider: "mercadolibre",
      label: body.label?.trim() || (shared ? "Mercado Libre negocio" : "Mercado Libre personal"),
      authMode: "oauth2-pkce",
    });
    const login = await startMercadoLibreOAuth({
      householdId: principal.householdId,
      memberId: principal.memberId,
      sourceAccountId: sourceAccount.id,
      redirectAfter: "/mercadolibre",
    });
    sendJson(response, 201, { sourceAccount, login });
    return true;
  }

  const accountMatch = path.match(
    /^\/v1\/mercadolibre\/accounts\/([0-9a-f-]{36})(?:\/(connect|sync|disconnect|dashboard))?$/i,
  );
  if (!accountMatch) return false;
  const accountId = accountMatch[1];
  const action = accountMatch[2] ?? "status";
  if (!accountId) return false;
  const account = await getMercadoLibreAccount(accountId);
  if (!account || account.householdId !== principal.householdId) {
    sendJson(response, 404, { error: "mercadolibre_account_not_found" });
    return true;
  }

  if (action === "dashboard" && request.method === "GET") {
    if (!canRead(principal, account)) {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }
    sendJson(response, 200, { account: publicAccount(principal, account), dashboard: await getMercadoLibreDashboard(account.id) });
    return true;
  }

  if (!canManage(principal, account)) {
    sendJson(response, 403, { error: "forbidden" });
    return true;
  }

  if (action === "status" && request.method === "GET") {
    sendJson(response, 200, { account: publicAccount(principal, account) });
    return true;
  }
  if (action === "connect" && request.method === "POST") {
    try {
      const login = await startMercadoLibreOAuth({
        householdId: principal.householdId,
        memberId: principal.memberId,
        sourceAccountId: account.id,
        redirectAfter: "/mercadolibre",
      });
      sendJson(response, 200, { login });
    } catch (error) {
      sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (action === "sync" && request.method === "POST") {
    try {
      sendJson(response, 200, { result: await syncMercadoLibreAccount(account.id) });
    } catch (error) {
      sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (action === "disconnect" && request.method === "POST") {
    await clearMercadoLibreOAuth(account.id);
    await markMercadoLibreDisconnected(account.id);
    sendJson(response, 200, { ok: true });
    return true;
  }

  return false;
}
