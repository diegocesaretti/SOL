import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "../../../http.js";
import type { AuthPrincipal } from "../../auth/session.js";
import { createSourceAccount } from "../../identity/source-accounts.js";
import { listRecentWhatsappCandidates } from "./candidates.js";
import { whatsappManager } from "./manager.js";
import {
  ensureWhatsappSessionRecord,
  getWhatsappAccount,
  listRecentWhatsappMessages,
  listWhatsappAccounts,
  type WhatsappAccountRecord,
} from "./repository.js";

async function readJson<T>(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<T | null> {
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

function isAdultManager(principal: AuthPrincipal): boolean {
  return principal.role === "owner" || principal.role === "adult";
}

function canManageAccount(
  principal: AuthPrincipal,
  account: WhatsappAccountRecord,
): boolean {
  if (principal.householdId !== account.householdId) return false;
  if (account.ownerMemberId) return account.ownerMemberId === principal.memberId;
  return isAdultManager(principal);
}

function canReadAccount(
  principal: AuthPrincipal,
  account: WhatsappAccountRecord,
): boolean {
  if (principal.householdId !== account.householdId) return false;
  if (account.ownerMemberId) return account.ownerMemberId === principal.memberId;
  return principal.role !== "guest";
}

async function accountInHousehold(
  sourceAccountId: string,
  principal: AuthPrincipal,
): Promise<WhatsappAccountRecord | null> {
  const account = await getWhatsappAccount(sourceAccountId);
  if (!account || account.householdId !== principal.householdId) return null;
  return account;
}

function publicAccount(
  principal: AuthPrincipal,
  account: WhatsappAccountRecord,
) {
  const runtime = whatsappManager.getStatus(account.id);
  const canManage = canManageAccount(principal, account);
  return {
    ...account,
    canManage,
    canRead: canReadAccount(principal, account),
    runtime: {
      state: runtime.state,
      reconnectAttempt: runtime.reconnectAttempt,
      updatedAt: runtime.updatedAt,
      lastError: canManage ? runtime.lastError : undefined,
      qrDataUrl: canManage ? runtime.qrDataUrl : undefined,
      pairingCode: canManage ? runtime.pairingCode : undefined,
    },
  };
}

export async function handleWhatsappApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthPrincipal,
): Promise<boolean> {
  if (path === "/v1/whatsapp/accounts" && request.method === "GET") {
    const accounts = await listWhatsappAccounts(
      principal.householdId,
      principal.memberId,
      isAdultManager(principal),
    );
    sendJson(response, 200, {
      accounts: accounts.map((account) => publicAccount(principal, account)),
    });
    return true;
  }

  if (path === "/v1/whatsapp/accounts" && request.method === "POST") {
    if (principal.role === "child" || principal.role === "guest") {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }

    const body = await readJson<{
      label?: string;
      shared?: boolean;
    }>(request, response);
    if (!body) return true;

    const shared = body.shared === true;
    if (shared && !isAdultManager(principal)) {
      sendJson(response, 403, { error: "shared_account_requires_adult_manager" });
      return true;
    }

    const sourceAccount = await createSourceAccount({
      householdId: principal.householdId,
      ownerMemberId: shared ? undefined : principal.memberId,
      provider: "whatsapp",
      label: body.label?.trim() || (shared ? "WhatsApp familiar" : "WhatsApp personal"),
      authMode: "linked-device",
    });
    await ensureWhatsappSessionRecord(sourceAccount.id);
    const account = await getWhatsappAccount(sourceAccount.id);
    sendJson(response, 201, {
      account: account ? publicAccount(principal, account) : sourceAccount,
    });
    return true;
  }

  const match = path.match(
    /^\/v1\/whatsapp\/accounts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(status|connect|restart|pairing-code|logout|messages|candidates))?$/i,
  );
  if (!match) return false;

  const accountId = match[1];
  const action = match[2] ?? "status";
  if (!accountId) return false;

  const account = await accountInHousehold(accountId, principal);
  if (!account) {
    sendJson(response, 404, { error: "whatsapp_account_not_found" });
    return true;
  }

  if ((action === "messages" || action === "candidates") && request.method === "GET") {
    if (!canReadAccount(principal, account)) {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }
    if (action === "messages") {
      sendJson(response, 200, {
        messages: await listRecentWhatsappMessages(account.id, 50),
      });
    } else {
      sendJson(response, 200, {
        candidates: await listRecentWhatsappCandidates(account.id, 50),
      });
    }
    return true;
  }

  if (!canManageAccount(principal, account)) {
    sendJson(response, 403, { error: "forbidden" });
    return true;
  }

  if (action === "status" && request.method === "GET") {
    sendJson(response, 200, {
      account: publicAccount(principal, account),
    });
    return true;
  }

  if (action === "connect" && request.method === "POST") {
    try {
      const runtime = await whatsappManager.start(account.id);
      sendJson(response, 200, { runtime });
    } catch (error) {
      sendJson(response, 503, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (action === "restart" && request.method === "POST") {
    try {
      const runtime = await whatsappManager.restart(account.id);
      sendJson(response, 200, { runtime });
    } catch (error) {
      sendJson(response, 503, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (action === "pairing-code" && request.method === "POST") {
    const body = await readJson<{ phoneNumber?: string }>(request, response);
    if (!body) return true;
    try {
      const runtime = await whatsappManager.requestPairingCode(
        account.id,
        body.phoneNumber ?? "",
      );
      sendJson(response, 200, { runtime });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (action === "logout" && request.method === "POST") {
    try {
      await whatsappManager.logout(account.id);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 503, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  return false;
}
