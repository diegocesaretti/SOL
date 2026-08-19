import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "../../../http.js";
import type { AuthPrincipal } from "../../auth/session.js";
import { createSourceAccount } from "../../identity/source-accounts.js";
import { whatsappManager } from "../whatsapp/manager.js";
import { ensureWhatsappSessionRecord } from "../whatsapp/repository.js";
import {
  getSolWhatsappAccount,
  getSolWhatsappBinding,
  listSolWhatsappBindings,
  revokeSolWhatsappBinding,
} from "./repository.js";
import { startSolWhatsappBinding } from "./service.js";

function manager(principal: AuthPrincipal): boolean {
  return principal.role === "owner" || principal.role === "adult";
}

async function body<T>(request: IncomingMessage, response: ServerResponse): Promise<T | null> {
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

async function waitForPairingReady(sourceAccountId: string): Promise<void> {
  await whatsappManager.start(sourceAccountId);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const status = whatsappManager.getStatus(sourceAccountId);
    if (status.state === "qr") return;
    if (status.state === "open") throw new Error("SOL WhatsApp is already linked");
    if (status.state === "error" || status.state === "logged_out") {
      throw new Error(status.lastError || "WhatsApp is not ready for pairing");
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("WhatsApp did not become ready for pairing; use QR instead");
}

function runtimeView(principal: AuthPrincipal, sourceAccountId: string) {
  const status = whatsappManager.getStatus(sourceAccountId);
  const canManage = manager(principal);
  return {
    state: status.state,
    phoneJid: status.phoneJid,
    displayName: status.displayName,
    reconnectAttempt: status.reconnectAttempt,
    updatedAt: status.updatedAt,
    lastError: canManage ? status.lastError : undefined,
    qrDataUrl: canManage ? status.qrDataUrl : undefined,
    pairingCode: canManage ? status.pairingCode : undefined,
  };
}

export async function handleSolWhatsappApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthPrincipal,
): Promise<boolean> {
  if (!path.startsWith("/v1/sol-whatsapp")) return false;

  if (path === "/v1/sol-whatsapp" && request.method === "GET") {
    const account = await getSolWhatsappAccount(principal.householdId);
    const binding = account
      ? await getSolWhatsappBinding(account.id, principal.memberId)
      : null;
    const bindings = account && manager(principal)
      ? await listSolWhatsappBindings(account.id)
      : undefined;
    sendJson(response, 200, {
      account: account
        ? { ...account, runtime: runtimeView(principal, account.id), canManage: manager(principal) }
        : null,
      binding,
      bindings,
    });
    return true;
  }

  if (path === "/v1/sol-whatsapp/account" && request.method === "POST") {
    if (!manager(principal)) {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }
    const existing = await getSolWhatsappAccount(principal.householdId);
    if (existing) {
      sendJson(response, 409, { error: "sol_whatsapp_already_exists", account: existing });
      return true;
    }
    try {
      const source = await createSourceAccount({
        householdId: principal.householdId,
        provider: "whatsapp",
        label: "WhatsApp de SOL",
        authMode: "linked-device-assistant",
      });
      await ensureWhatsappSessionRecord(source.id);
      const account = await getSolWhatsappAccount(principal.householdId);
      sendJson(response, 201, { account });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "23505") {
        sendJson(response, 409, { error: "sol_whatsapp_already_exists" });
        return true;
      }
      throw error;
    }
    return true;
  }

  const account = await getSolWhatsappAccount(principal.householdId);
  if (!account) {
    sendJson(response, 404, { error: "sol_whatsapp_not_configured" });
    return true;
  }

  if (path === "/v1/sol-whatsapp/bind/start" && request.method === "POST") {
    if (principal.role === "guest") {
      sendJson(response, 403, { error: "guests_cannot_bind" });
      return true;
    }
    const challenge = await startSolWhatsappBinding(account.id, principal.memberId);
    sendJson(response, 200, challenge);
    return true;
  }

  if (path === "/v1/sol-whatsapp/bind/revoke" && request.method === "POST") {
    await revokeSolWhatsappBinding(account.id, principal.memberId);
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (!["/v1/sol-whatsapp/connect", "/v1/sol-whatsapp/restart", "/v1/sol-whatsapp/logout", "/v1/sol-whatsapp/pairing-code"].includes(path)) {
    return false;
  }
  if (!manager(principal)) {
    sendJson(response, 403, { error: "forbidden" });
    return true;
  }

  if (path === "/v1/sol-whatsapp/connect" && request.method === "POST") {
    try {
      sendJson(response, 200, { runtime: await whatsappManager.start(account.id) });
    } catch (error) {
      sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (path === "/v1/sol-whatsapp/restart" && request.method === "POST") {
    try {
      sendJson(response, 200, { runtime: await whatsappManager.restart(account.id) });
    } catch (error) {
      sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (path === "/v1/sol-whatsapp/logout" && request.method === "POST") {
    try {
      await whatsappManager.logout(account.id);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (path === "/v1/sol-whatsapp/pairing-code" && request.method === "POST") {
    const input = await body<{ phoneNumber?: string }>(request, response);
    if (!input) return true;
    try {
      await waitForPairingReady(account.id);
      const runtime = await whatsappManager.requestPairingCode(account.id, input.phoneNumber ?? "");
      sendJson(response, 200, { runtime });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  return false;
}
