import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "../../../http.js";
import type { AuthPrincipal } from "../../auth/session.js";
import { createSourceAccount } from "../../identity/source-accounts.js";
import {
  clearGmailOAuth,
  completeGmailOAuth,
  gmailConfigured,
  startGmailOAuth,
} from "./oauth.js";
import {
  ensureGmailAccountRecord,
  getGmailAccount,
  listGmailAccounts,
  markGmailDisconnected,
  type GmailAccount,
} from "./repository.js";
import { syncGmailAccount } from "./sync.js";

function adult(principal: AuthPrincipal): boolean {
  return principal.role === "owner" || principal.role === "adult";
}
function canManage(principal: AuthPrincipal, account: GmailAccount): boolean {
  if (principal.householdId !== account.householdId) return false;
  if (account.ownerMemberId) return account.ownerMemberId === principal.memberId;
  return adult(principal);
}
function canRead(principal: AuthPrincipal, account: GmailAccount): boolean {
  if (principal.householdId !== account.householdId) return false;
  if (account.ownerMemberId) return account.ownerMemberId === principal.memberId;
  return principal.role !== "guest";
}
async function readJson<T>(request: IncomingMessage, response: ServerResponse): Promise<T | null> {
  if (!request.headers["content-type"]?.includes("application/json")) {
    sendJson(response, 415, { error: "content-type must be application/json" });
    return null;
  }
  try { return await readJsonBody<T>(request); }
  catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid_request" });
    return null;
  }
}

export async function handleGmailOAuthCallback(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://sol.local");
  if (request.method !== "GET" || url.pathname !== "/v1/gmail/callback") return false;
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    response.statusCode = 302;
    response.setHeader("location", `/inputs?gmail_error=${encodeURIComponent(oauthError)}`);
    response.end();
    return true;
  }
  if (!state || !code) {
    sendJson(response, 400, { error: "missing_gmail_oauth_callback_parameters" });
    return true;
  }
  try {
    const completed = await completeGmailOAuth(state, code);
    await ensureGmailAccountRecord(completed.sourceAccountId);
    void syncGmailAccount(completed.sourceAccountId).catch((error) =>
      console.error(`[gmail:${completed.sourceAccountId}] initial sync failed`, error),
    );
    const separator = completed.redirectAfter.includes("?") ? "&" : "?";
    response.statusCode = 302;
    response.setHeader("location", `${completed.redirectAfter}${separator}gmail_connected=1`);
    response.end();
  } catch (error) {
    response.statusCode = 302;
    response.setHeader(
      "location",
      `/inputs?gmail_error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`,
    );
    response.end();
  }
  return true;
}

export async function handleGmailApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthPrincipal,
): Promise<boolean> {
  if (!path.startsWith("/v1/gmail")) return false;

  if (path === "/v1/gmail/status" && request.method === "GET") {
    sendJson(response, 200, {
      configured: gmailConfigured(),
      redirectUri: "configured_on_server",
      mode: "read-only",
    });
    return true;
  }

  if (path === "/v1/gmail/accounts" && request.method === "GET") {
    const accounts = await listGmailAccounts(
      principal.householdId,
      principal.memberId,
      adult(principal),
    );
    sendJson(response, 200, {
      accounts: accounts.map((account) => ({
        ...account,
        canRead: canRead(principal, account),
        canManage: canManage(principal, account),
      })),
    });
    return true;
  }

  if (path === "/v1/gmail/accounts" && request.method === "POST") {
    if (principal.role === "child" || principal.role === "guest") {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }
    if (!gmailConfigured()) {
      sendJson(response, 503, { error: "gmail_oauth_not_configured" });
      return true;
    }
    const body = await readJson<{ label?: string; shared?: boolean }>(request, response);
    if (!body) return true;
    const shared = body.shared === true;
    if (shared && !adult(principal)) {
      sendJson(response, 403, { error: "shared_account_requires_adult_manager" });
      return true;
    }
    try {
      const sourceAccount = await createSourceAccount({
        householdId: principal.householdId,
        ownerMemberId: shared ? undefined : principal.memberId,
        provider: "gmail",
        label: body.label?.trim() || (shared ? "Gmail familiar" : "Gmail personal"),
        authMode: "oauth2-readonly",
      });
      await ensureGmailAccountRecord(sourceAccount.id);
      const login = await startGmailOAuth({
        householdId: principal.householdId,
        memberId: principal.memberId,
        sourceAccountId: sourceAccount.id,
        redirectAfter: "/inputs",
      });
      sendJson(response, 201, { sourceAccount, login });
    } catch (error) {
      sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  const match = path.match(/^\/v1\/gmail\/accounts\/([0-9a-f-]{36})(?:\/(connect|sync|disconnect))?$/i);
  if (!match?.[1]) return false;
  const sourceAccountId = match[1];
  const action = match[2] ?? "status";
  const account = await getGmailAccount(sourceAccountId);
  if (!account || account.householdId !== principal.householdId) {
    sendJson(response, 404, { error: "gmail_account_not_found" });
    return true;
  }
  if (action === "status" && request.method === "GET") {
    if (!canRead(principal, account)) {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }
    sendJson(response, 200, {
      account: { ...account, canRead: true, canManage: canManage(principal, account) },
    });
    return true;
  }
  if (!canManage(principal, account)) {
    sendJson(response, 403, { error: "forbidden" });
    return true;
  }
  if (action === "connect" && request.method === "POST") {
    try {
      const login = await startGmailOAuth({
        householdId: principal.householdId,
        memberId: principal.memberId,
        sourceAccountId,
        redirectAfter: "/inputs",
      });
      sendJson(response, 200, { login });
    } catch (error) {
      sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (action === "sync" && request.method === "POST") {
    try { sendJson(response, 200, { result: await syncGmailAccount(sourceAccountId) }); }
    catch (error) {
      sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (action === "disconnect" && request.method === "POST") {
    await clearGmailOAuth(sourceAccountId);
    await markGmailDisconnected(sourceAccountId);
    sendJson(response, 200, { ok: true });
    return true;
  }
  return false;
}
