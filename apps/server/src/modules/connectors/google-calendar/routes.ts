import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "../../../http.js";
import type { AuthPrincipal } from "../../auth/session.js";
import { createSourceAccount } from "../../identity/source-accounts.js";
import {
  clearGoogleOAuth,
  completeGoogleOAuth,
  googleCalendarConfigured,
  startGoogleOAuth,
} from "./oauth.js";
import {
  configureGoogleCalendar,
  getGoogleCalendarAccount,
  listGoogleCalendarAccounts,
  listGoogleCalendars,
  markGoogleAccountDisconnected,
  type GoogleCalendarAccount,
} from "./repository.js";
import {
  discoverGoogleCalendars,
  listUpcomingGoogleEvents,
  syncGoogleCalendarAccount,
} from "./sync.js";

async function readJson<T>(request: IncomingMessage, response: ServerResponse): Promise<T | null> {
  if (!request.headers["content-type"]?.includes("application/json")) {
    sendJson(response, 415, { error: "content-type must be application/json" });
    return null;
  }
  try {
    return await readJsonBody<T>(request);
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : "invalid request body",
    });
    return null;
  }
}

function adult(principal: AuthPrincipal): boolean {
  return principal.role === "owner" || principal.role === "adult";
}

function canManage(principal: AuthPrincipal, account: GoogleCalendarAccount): boolean {
  if (principal.householdId !== account.householdId) return false;
  if (account.ownerMemberId) return account.ownerMemberId === principal.memberId;
  return adult(principal);
}

function canRead(principal: AuthPrincipal, account: GoogleCalendarAccount): boolean {
  if (principal.householdId !== account.householdId) return false;
  if (account.ownerMemberId) return account.ownerMemberId === principal.memberId;
  return principal.role !== "guest";
}

function publicAccount(principal: AuthPrincipal, account: GoogleCalendarAccount) {
  return {
    ...account,
    canManage: canManage(principal, account),
    canRead: canRead(principal, account),
    googleEmail: canManage(principal, account) || canRead(principal, account) ? account.googleEmail : undefined,
  };
}

export async function handleGoogleOAuthCallback(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://sol.local");
  if (request.method !== "GET" || url.pathname !== "/v1/google/callback") return false;

  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    response.statusCode = 302;
    response.setHeader("location", `/calendar?error=${encodeURIComponent(oauthError)}`);
    response.end();
    return true;
  }
  if (!state || !code) {
    sendJson(response, 400, { error: "missing_google_oauth_callback_parameters" });
    return true;
  }

  try {
    const completed = await completeGoogleOAuth(state, code);
    await discoverGoogleCalendars(completed.sourceAccountId);
    void syncGoogleCalendarAccount(completed.sourceAccountId).catch((error) =>
      console.error(`[calendar:${completed.sourceAccountId}] initial sync failed`, error),
    );
    const separator = completed.redirectAfter.includes("?") ? "&" : "?";
    response.statusCode = 302;
    response.setHeader("location", `${completed.redirectAfter}${separator}connected=1`);
    response.end();
  } catch (error) {
    response.statusCode = 302;
    response.setHeader(
      "location",
      `/calendar?error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`,
    );
    response.end();
  }
  return true;
}

export async function handleCalendarApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthPrincipal,
): Promise<boolean> {
  if (path === "/v1/calendar/status" && request.method === "GET") {
    sendJson(response, 200, { configured: googleCalendarConfigured() });
    return true;
  }

  if (path === "/v1/calendar/accounts" && request.method === "GET") {
    const accounts = await listGoogleCalendarAccounts(
      principal.householdId,
      principal.memberId,
      adult(principal),
    );
    sendJson(response, 200, { accounts: accounts.map((account) => publicAccount(principal, account)) });
    return true;
  }

  if (path === "/v1/calendar/accounts" && request.method === "POST") {
    if (principal.role === "child" || principal.role === "guest") {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }
    if (!googleCalendarConfigured()) {
      sendJson(response, 503, { error: "google_calendar_not_configured" });
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
      provider: "google_calendar",
      label: body.label?.trim() || (shared ? "Google Calendar familiar" : "Google Calendar personal"),
      authMode: "oauth2",
    });
    const login = await startGoogleOAuth({
      householdId: principal.householdId,
      memberId: principal.memberId,
      sourceAccountId: sourceAccount.id,
      redirectAfter: "/calendar",
    });
    sendJson(response, 201, { sourceAccount, login });
    return true;
  }

  if (path === "/v1/calendar/upcoming" && request.method === "GET") {
    const url = new URL(request.url ?? path, "http://sol.local");
    const from = new Date(url.searchParams.get("from") || Date.now());
    const to = new Date(url.searchParams.get("to") || Date.now() + 7 * 24 * 60 * 60 * 1000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
      sendJson(response, 400, { error: "invalid_calendar_window" });
      return true;
    }
    const accounts = await listGoogleCalendarAccounts(principal.householdId, principal.memberId, false);
    const events = [];
    for (const account of accounts.filter((item) => item.status === "connected" && canRead(principal, item))) {
      events.push(...(await listUpcomingGoogleEvents(account.id, from, to)));
    }
    sendJson(response, 200, { events });
    return true;
  }

  const accountMatch = path.match(
    /^\/v1\/calendar\/accounts\/([0-9a-f-]{36})(?:\/(connect|sync|disconnect|calendars))?$/i,
  );
  if (accountMatch) {
    const accountId = accountMatch[1];
    const action = accountMatch[2] ?? "status";
    if (!accountId) return false;
    const account = await getGoogleCalendarAccount(accountId);
    if (!account || account.householdId !== principal.householdId) {
      sendJson(response, 404, { error: "calendar_account_not_found" });
      return true;
    }

    if (action === "calendars" && request.method === "GET") {
      if (!canRead(principal, account)) {
        sendJson(response, 403, { error: "forbidden" });
        return true;
      }
      sendJson(response, 200, { calendars: await listGoogleCalendars(account.id) });
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
        const login = await startGoogleOAuth({
          householdId: principal.householdId,
          memberId: principal.memberId,
          sourceAccountId: account.id,
          redirectAfter: "/calendar",
        });
        sendJson(response, 200, { login });
      } catch (error) {
        sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (action === "sync" && request.method === "POST") {
      try {
        await discoverGoogleCalendars(account.id);
        sendJson(response, 200, { result: await syncGoogleCalendarAccount(account.id) });
      } catch (error) {
        sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (action === "disconnect" && request.method === "POST") {
      await clearGoogleOAuth(account.id);
      await markGoogleAccountDisconnected(account.id);
      sendJson(response, 200, { ok: true });
      return true;
    }
  }

  const calendarMatch = path.match(/^\/v1\/calendar\/calendars\/([0-9a-f-]{36})$/i);
  if (calendarMatch && request.method === "PATCH") {
    const calendarId = calendarMatch[1];
    if (!calendarId) return false;
    const body = await readJson<{
      sourceAccountId?: string;
      selectedForSync?: boolean;
      selectedForWrite?: boolean;
    }>(request, response);
    if (!body?.sourceAccountId) return true;
    const account = await getGoogleCalendarAccount(body.sourceAccountId);
    if (!account || !canManage(principal, account)) {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }
    const calendar = await configureGoogleCalendar(calendarId, account.id, {
      selectedForSync: body.selectedForSync,
      selectedForWrite: body.selectedForWrite,
    });
    if (!calendar) {
      sendJson(response, 404, { error: "calendar_not_found" });
      return true;
    }
    sendJson(response, 200, { calendar });
    return true;
  }

  return false;
}
