import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config.js";
import { InMemoryEventBus } from "./core/event-bus.js";
import { OutboxDispatcher } from "./core/outbox-dispatcher.js";
import { checkDatabase, closeDatabase } from "./database/client.js";
import { readJsonBody, sendHtml, sendJson } from "./http.js";
import {
  authenticateRequest,
  clearedSessionCookie,
  loginMember,
  revokeRequestSession,
  sessionCookie,
  type AuthPrincipal,
} from "./modules/auth/session.js";
import { handleAiApi } from "./modules/ai/routes.js";
import { codexAppServer } from "./modules/ai/codex/runtime.js";
import {
  handleCalendarApi,
  handleGoogleOAuthCallback,
} from "./modules/connectors/google-calendar/routes.js";
import { CalendarSyncScheduler } from "./modules/connectors/google-calendar/scheduler.js";
import { handleGmailApi, handleGmailOAuthCallback } from "./modules/connectors/gmail/routes.js";
import { GmailSyncScheduler } from "./modules/connectors/gmail/scheduler.js";
import { homeAssistantManager } from "./modules/connectors/home-assistant/manager.js";
import { handleHomeAssistantApi } from "./modules/connectors/home-assistant/routes.js";
import {
  handleMercadoLibreApi,
  handleMercadoLibreOAuthCallback,
} from "./modules/connectors/mercadolibre/routes.js";
import { MercadoLibreSyncScheduler } from "./modules/connectors/mercadolibre/scheduler.js";
import { handleSolWhatsappApi } from "./modules/connectors/sol-whatsapp/routes.js";
import { registerSolWhatsappDelivery } from "./modules/connectors/sol-whatsapp/service.js";
import { handleWhatsappApi } from "./modules/connectors/whatsapp/routes.js";
import { whatsappManager } from "./modules/connectors/whatsapp/manager.js";
import { handleExecutiveApi } from "./modules/executive/routes.js";
import { registerExecutiveProposalProcessor } from "./modules/executive/proposals.js";
import { ExecutiveScheduler } from "./modules/executive/scheduler.js";
import {
  createMember,
  MemberValidationError,
  type NewMemberRole,
} from "./modules/identity/members.js";
import { getOnboardingState, listMembers } from "./modules/identity/repository.js";
import {
  createSourceAccount,
  listSourceAccounts,
  SourceAccountValidationError,
} from "./modules/identity/source-accounts.js";
import { handleInputsApi } from "./modules/inputs/routes.js";
import { handleLifeApi } from "./modules/life/routes.js";
import { registerCandidateProcessor } from "./modules/knowledge/candidate-processor.js";
import { handleKnowledgeApi } from "./modules/knowledge/routes.js";
import { handleMcpApi } from "./modules/mcp/routes.js";
import {
  AlreadyConfiguredError,
  ValidationError,
  bootstrapHousehold,
  type BootstrapInput,
} from "./modules/onboarding/service.js";
import { renderAiPage } from "./ui/ai.js";
import { renderCalendarPage } from "./ui/calendar.js";
import { renderExecutivePage } from "./ui/executive.js";
import { renderHomeAssistantPage } from "./ui/home-assistant.js";
import { renderInputsPage } from "./ui/inputs.js";
import { renderLifePage } from "./ui/life.js";
import { renderMcpPage } from "./ui/mcp.js";
import { renderMercadoLibrePage } from "./ui/mercadolibre.js";
import { renderOnboardingPage } from "./ui/onboarding.js";
import { renderOutputsPage } from "./ui/outputs.js";
import { renderSolWhatsappPage } from "./ui/sol-whatsapp.js";
import { renderWhatsappPage } from "./ui/whatsapp.js";
import { startWindowsTray, stopWindowsTray } from "./windows/tray.js";

export const eventBus = new InMemoryEventBus();
const unregisterCandidateProcessor = registerCandidateProcessor(eventBus);
const unregisterExecutiveProcessor = registerExecutiveProposalProcessor(eventBus);
const unregisterSolWhatsappDelivery = registerSolWhatsappDelivery(eventBus, whatsappManager);
const outboxDispatcher = new OutboxDispatcher(eventBus, config.outboxPollMs);
const calendarScheduler = new CalendarSyncScheduler(config.calendarSyncMs);
const gmailScheduler = new GmailSyncScheduler(config.gmailSyncMs);
const mercadoLibreScheduler = new MercadoLibreSyncScheduler(config.mercadoLibreSyncMs);
const executiveScheduler = new ExecutiveScheduler(config.executivePollMs);

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://sol.local");
}

function pathname(request: IncomingMessage): string {
  return requestUrl(request).pathname;
}

function advancedRequested(request: IncomingMessage): boolean {
  return requestUrl(request).searchParams.get("advanced") === "1";
}

function redirect(response: ServerResponse, location: string): void {
  response.statusCode = 302;
  response.setHeader("location", location);
  response.end();
}

function requireJson(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.headers["content-type"]?.includes("application/json")) return true;
  sendJson(response, 415, { error: "content-type must be application/json" });
  return false;
}

async function jsonBody<T>(request: IncomingMessage, response: ServerResponse): Promise<T | null> {
  if (!requireJson(request, response)) return null;
  try {
    return await readJsonBody<T>(request);
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : "invalid request body",
    });
    return null;
  }
}

async function principalFor(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<AuthPrincipal | null> {
  const principal = await authenticateRequest(request);
  if (!principal) sendJson(response, 401, { error: "unauthenticated" });
  return principal;
}

function canManageMembers(principal: AuthPrincipal): boolean {
  return principal.role === "owner" || principal.role === "adult";
}

function canCreateRole(principal: AuthPrincipal, role: NewMemberRole): boolean {
  if (principal.role === "owner") return true;
  if (principal.role === "adult") return role !== "adult";
  return false;
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = pathname(request);

  // OAuth callbacks are authenticated by one-time state/PKCE rather than the SOL cookie.
  if (await handleGoogleOAuthCallback(request, response)) return;
  if (await handleGmailOAuthCallback(request, response)) return;
  if (await handleMercadoLibreOAuthCallback(request, response)) return;

  if (request.method === "GET" && path === "/") {
    sendHtml(response, 200, renderOnboardingPage());
    return;
  }
  if (request.method === "GET" && path === "/inputs") {
    sendHtml(response, 200, renderInputsPage());
    return;
  }
  if (request.method === "GET" && path === "/outputs") {
    sendHtml(response, 200, renderOutputsPage());
    return;
  }
  if (request.method === "GET" && path === "/life") {
    sendHtml(response, 200, renderLifePage());
    return;
  }
  if (request.method === "GET" && path === "/mcp") {
    sendHtml(response, 200, renderMcpPage());
    return;
  }
  if (request.method === "GET" && path === "/ai") {
    sendHtml(response, 200, renderAiPage());
    return;
  }

  // Provider-specific pages remain available only as advanced adapters. Normal use is Inputs/Outputs.
  if (request.method === "GET" && path === "/whatsapp") {
    if (!advancedRequested(request)) { redirect(response, "/inputs"); return; }
    sendHtml(response, 200, renderWhatsappPage());
    return;
  }
  if (request.method === "GET" && path === "/home-assistant") {
    if (!advancedRequested(request)) { redirect(response, "/inputs"); return; }
    sendHtml(response, 200, renderHomeAssistantPage());
    return;
  }
  if (request.method === "GET" && path === "/mercadolibre") {
    if (!advancedRequested(request)) { redirect(response, "/inputs"); return; }
    sendHtml(response, 200, renderMercadoLibrePage());
    return;
  }
  if (request.method === "GET" && path === "/calendar") {
    if (!advancedRequested(request)) { redirect(response, "/inputs"); return; }
    sendHtml(response, 200, renderCalendarPage());
    return;
  }
  if (request.method === "GET" && path === "/sol-whatsapp") {
    if (!advancedRequested(request)) { redirect(response, "/outputs"); return; }
    sendHtml(response, 200, renderSolWhatsappPage());
    return;
  }
  if (request.method === "GET" && path === "/executive") {
    if (!advancedRequested(request)) { redirect(response, "/outputs"); return; }
    sendHtml(response, 200, renderExecutivePage());
    return;
  }

  if (request.method === "GET" && path === "/health") {
    const database = await checkDatabase();
    sendJson(response, database ? 200 : 503, {
      ok: database,
      service: "sol-core",
      database,
    });
    return;
  }

  if (request.method === "GET" && path === "/v1/system") {
    const database = await checkDatabase();
    sendJson(response, 200, {
      name: "SOL",
      architecture: "family-first data/knowledge OS + MCP",
      version: "0.10.0",
      database,
      reasoningInterface: "mcp",
      optionalAiProvider: "codex",
      sources: ["whatsapp", "gmail", "google_calendar", "home_assistant", "mercadolibre"],
      interfaces: ["mcp_stdio", "web", "sol_whatsapp", "windows_tray"],
      views: ["inputs", "outputs", "life_timeline", "people", "projects", "mcp_access"],
      plannedSources: ["google_drive", "contacts", "voice"],
    });
    return;
  }

  if (request.method === "GET" && path === "/v1/onboarding") {
    sendJson(response, 200, await getOnboardingState());
    return;
  }

  if (request.method === "POST" && path === "/v1/onboarding") {
    const input = await jsonBody<BootstrapInput>(request, response);
    if (!input) return;
    try {
      const result = await bootstrapHousehold(input);
      const login = await loginMember(result.household.id, result.owner.loginName, input.ownerPassword);
      if (!login) throw new Error("Owner session could not be created");
      response.setHeader("set-cookie", sessionCookie(login.token, login.maxAgeSeconds));
      sendJson(response, 201, { household: result.household, member: login.principal });
    } catch (error) {
      if (error instanceof AlreadyConfiguredError) {
        sendJson(response, 409, { error: error.message });
        return;
      }
      if (error instanceof ValidationError) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      throw error;
    }
    return;
  }

  if (request.method === "POST" && path === "/v1/auth/login") {
    const input = await jsonBody<{ householdId?: string; loginName?: string; password?: string }>(request, response);
    if (!input) return;
    if (!input.householdId || !input.loginName || !input.password) {
      sendJson(response, 400, { error: "householdId, loginName and password are required" });
      return;
    }
    const login = await loginMember(input.householdId, input.loginName, input.password);
    if (!login) {
      sendJson(response, 401, { error: "invalid_credentials" });
      return;
    }
    response.setHeader("set-cookie", sessionCookie(login.token, login.maxAgeSeconds));
    sendJson(response, 200, { member: login.principal });
    return;
  }

  if (request.method === "GET" && path === "/v1/auth/me") {
    const principal = await principalFor(request, response);
    if (!principal) return;
    sendJson(response, 200, { member: principal });
    return;
  }

  if (request.method === "POST" && path === "/v1/auth/logout") {
    await revokeRequestSession(request);
    response.setHeader("set-cookie", clearedSessionCookie());
    sendJson(response, 200, { ok: true });
    return;
  }

  if (path === "/v1/inputs" || path.startsWith("/v1/inputs/")) {
    const principal = await principalFor(request, response);
    if (!principal) return;
    if (await handleInputsApi(path, request, response, principal)) return;
  }
  if (path.startsWith("/v1/ai/")) {
    const principal = await principalFor(request, response);
    if (!principal) return;
    if (await handleAiApi(path, request, response, principal)) return;
  }
  if (path.startsWith("/v1/sol-whatsapp")) {
    const principal = await principalFor(request, response);
    if (!principal) return;
    if (await handleSolWhatsappApi(path, request, response, principal)) return;
  }
  if (path.startsWith("/v1/whatsapp/")) {
    const principal = await principalFor(request, response);
    if (!principal) return;
    if (await handleWhatsappApi(path, request, response, principal)) return;
  }
  if (path.startsWith("/v1/gmail")) {
    const principal = await principalFor(request, response);
    if (!principal) return;
    if (await handleGmailApi(path, request, response, principal)) return;
  }
  if (path.startsWith("/v1/calendar/")) {
    const principal = await principalFor(request, response);
    if (!principal) return;
    if (await handleCalendarApi(path, request, response, principal)) return;
  }
  if (path.startsWith("/v1/home-assistant")) {
    const principal = await principalFor(request, response);
    if (!principal) return;
    if (await handleHomeAssistantApi(path, request, response, principal)) return;
  }
  if (path.startsWith("/v1/mercadolibre/")) {
    const principal = await principalFor(request, response);
    if (!principal) return;
    if (await handleMercadoLibreApi(path, request, response, principal)) return;
  }
  if (path.startsWith("/v1/executive/")) {
    const principal = await principalFor(request, response);
    if (!principal) return;
    if (await handleExecutiveApi(path, request, response, principal)) return;
  }
  if (path.startsWith("/v1/life/")) {
    const principal = await principalFor(request, response);
    if (!principal) return;
    if (await handleLifeApi(path, request, response, principal)) return;
  }
  if (path.startsWith("/v1/knowledge/")) {
    const principal = await principalFor(request, response);
    if (!principal) return;
    if (await handleKnowledgeApi(path, request, response, principal)) return;
  }
  if (path.startsWith("/v1/mcp/")) {
    const principal = await principalFor(request, response);
    if (!principal) return;
    if (await handleMcpApi(path, request, response, principal)) return;
  }

  if (path === "/v1/source-accounts") {
    const principal = await principalFor(request, response);
    if (!principal) return;

    if (request.method === "GET") {
      const canSeeAll = principal.role === "owner" || principal.role === "adult";
      sendJson(response, 200, {
        sourceAccounts: await listSourceAccounts(principal.householdId, principal.memberId, canSeeAll),
      });
      return;
    }

    if (request.method === "POST") {
      if (principal.role === "child" || principal.role === "guest") {
        sendJson(response, 403, { error: "forbidden" });
        return;
      }
      const input = await jsonBody<{
        provider?: string;
        label?: string;
        authMode?: string;
        ownerMemberId?: string;
        shared?: boolean;
      }>(request, response);
      if (!input) return;
      const provider = input.provider?.trim().toLowerCase();
      if (["whatsapp", "gmail", "google_calendar", "home_assistant", "mercadolibre"].includes(provider ?? "")) {
        const dedicated =
          provider === "whatsapp" ? "whatsapp" :
          provider === "gmail" ? "gmail" :
          provider === "google_calendar" ? "calendar" :
          provider === "home_assistant" ? "home-assistant" : "mercadolibre";
        sendJson(response, 400, { error: `Use the dedicated /v1/${dedicated}/accounts endpoint` });
        return;
      }
      const manager = principal.role === "owner" || principal.role === "adult";
      const ownerMemberId = manager
        ? input.shared
          ? undefined
          : input.ownerMemberId ?? principal.memberId
        : principal.memberId;
      try {
        const sourceAccount = await createSourceAccount({
          householdId: principal.householdId,
          ownerMemberId,
          provider: input.provider ?? "",
          label: input.label ?? "",
          authMode: input.authMode,
        });
        sendJson(response, 201, { sourceAccount });
      } catch (error) {
        if (error instanceof SourceAccountValidationError) {
          sendJson(response, 400, { error: error.message });
          return;
        }
        throw error;
      }
      return;
    }
  }

  const membersMatch = path.match(
    /^\/v1\/households\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/members$/i,
  );
  if (membersMatch) {
    const principal = await principalFor(request, response);
    if (!principal) return;
    const householdId = membersMatch[1];
    if (!householdId || principal.householdId !== householdId) {
      sendJson(response, 403, { error: "forbidden" });
      return;
    }
    if (request.method === "GET") {
      sendJson(response, 200, { members: await listMembers(householdId) });
      return;
    }
    if (request.method === "POST") {
      if (!canManageMembers(principal)) {
        sendJson(response, 403, { error: "forbidden" });
        return;
      }
      const input = await jsonBody<{
        displayName?: string;
        loginName?: string;
        password?: string;
        role?: NewMemberRole;
        locale?: string;
        timezone?: string;
      }>(request, response);
      if (!input) return;
      if (!input.role || !canCreateRole(principal, input.role)) {
        sendJson(response, 403, { error: "role_not_allowed" });
        return;
      }
      try {
        const member = await createMember({
          householdId,
          displayName: input.displayName ?? "",
          loginName: input.loginName ?? "",
          password: input.password ?? "",
          role: input.role,
          locale: input.locale,
          timezone: input.timezone,
        });
        sendJson(response, 201, { member });
      } catch (error) {
        if (error instanceof MemberValidationError) {
          sendJson(response, 400, { error: error.message });
          return;
        }
        throw error;
      }
      return;
    }
  }

  sendJson(response, 404, { error: "not_found" });
}

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    console.error("Unhandled request error", error);
    if (!response.headersSent) sendJson(response, 500, { error: "internal_error" });
    else if (!response.writableEnded) response.end();
  });
});

server.listen(config.port, config.host, () => {
  console.log(`SOL Core listening on http://${config.host}:${config.port}`);
  startWindowsTray();
  outboxDispatcher.start();
  calendarScheduler.start();
  gmailScheduler.start();
  mercadoLibreScheduler.start();
  executiveScheduler.start();
  void whatsappManager.startLinkedAccounts().catch((error) => {
    console.error("WhatsApp autostart failed", error);
  });
  void homeAssistantManager.startConfiguredAccounts().catch((error) => {
    console.error("Home Assistant autostart failed", error);
  });
  if (config.host !== "127.0.0.1" && config.host !== "localhost") {
    console.warn(
      "SOL is listening beyond localhost. Use HTTPS and review member authentication before exposing it broadly.",
    );
  }
});

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down SOL Core`);
  stopWindowsTray();
  outboxDispatcher.stop();
  calendarScheduler.stop();
  gmailScheduler.stop();
  mercadoLibreScheduler.stop();
  executiveScheduler.stop();
  unregisterSolWhatsappDelivery();
  unregisterExecutiveProcessor();
  unregisterCandidateProcessor();
  await Promise.all([
    whatsappManager.stopAll().catch(() => undefined),
    homeAssistantManager.stopAll().catch(() => undefined),
    codexAppServer.stop().catch(() => undefined),
  ]);
  server.close(async () => {
    await closeDatabase();
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));