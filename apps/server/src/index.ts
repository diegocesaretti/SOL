import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config.js";
import { InMemoryEventBus } from "./core/event-bus.js";
import { checkDatabase, closeDatabase } from "./database/client.js";
import { readJsonBody, sendHtml, sendJson } from "./http.js";
import {
  authenticateRequest,
  clearedSessionCookie,
  loginMember,
  revokeRequestSession,
  sessionCookie,
} from "./modules/auth/session.js";
import {
  getOnboardingState,
  listMembers,
} from "./modules/identity/repository.js";
import {
  AlreadyConfiguredError,
  ValidationError,
  bootstrapHousehold,
  type BootstrapInput,
} from "./modules/onboarding/service.js";
import { renderOnboardingPage } from "./ui/onboarding.js";

export const eventBus = new InMemoryEventBus();

function pathname(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://sol.local").pathname;
}

function requireJson(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.headers["content-type"]?.includes("application/json")) return true;
  sendJson(response, 415, { error: "content-type must be application/json" });
  return false;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const path = pathname(request);

  if (request.method === "GET" && path === "/") {
    sendHtml(response, 200, renderOnboardingPage());
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
      architecture: "family-first modular monolith",
      version: "0.1.0",
      database,
    });
    return;
  }

  if (request.method === "GET" && path === "/v1/onboarding") {
    sendJson(response, 200, await getOnboardingState());
    return;
  }

  if (request.method === "POST" && path === "/v1/onboarding") {
    if (!requireJson(request, response)) return;

    try {
      const input = await readJsonBody<BootstrapInput>(request);
      const result = await bootstrapHousehold(input);
      const login = await loginMember(
        result.household.id,
        result.owner.loginName,
        input.ownerPassword,
      );
      if (!login) throw new Error("Owner session could not be created");

      response.setHeader(
        "set-cookie",
        sessionCookie(login.token, login.maxAgeSeconds),
      );
      sendJson(response, 201, {
        household: result.household,
        member: login.principal,
      });
    } catch (error) {
      if (error instanceof AlreadyConfiguredError) {
        sendJson(response, 409, { error: error.message });
        return;
      }
      if (error instanceof ValidationError) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      if (error instanceof Error && error.message.startsWith("request body")) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      throw error;
    }
    return;
  }

  if (request.method === "POST" && path === "/v1/auth/login") {
    if (!requireJson(request, response)) return;
    const input = await readJsonBody<{
      householdId?: string;
      loginName?: string;
      password?: string;
    }>(request);

    if (!input.householdId || !input.loginName || !input.password) {
      sendJson(response, 400, { error: "householdId, loginName and password are required" });
      return;
    }

    const login = await loginMember(
      input.householdId,
      input.loginName,
      input.password,
    );
    if (!login) {
      sendJson(response, 401, { error: "invalid_credentials" });
      return;
    }

    response.setHeader(
      "set-cookie",
      sessionCookie(login.token, login.maxAgeSeconds),
    );
    sendJson(response, 200, { member: login.principal });
    return;
  }

  if (request.method === "GET" && path === "/v1/auth/me") {
    const principal = await authenticateRequest(request);
    if (!principal) {
      sendJson(response, 401, { error: "unauthenticated" });
      return;
    }
    sendJson(response, 200, { member: principal });
    return;
  }

  if (request.method === "POST" && path === "/v1/auth/logout") {
    await revokeRequestSession(request);
    response.setHeader("set-cookie", clearedSessionCookie());
    sendJson(response, 200, { ok: true });
    return;
  }

  const membersMatch = path.match(
    /^\/v1\/households\/([0-9a-f-]{36})\/members$/i,
  );
  if (request.method === "GET" && membersMatch) {
    const principal = await authenticateRequest(request);
    if (!principal) {
      sendJson(response, 401, { error: "unauthenticated" });
      return;
    }

    const householdId = membersMatch[1];
    if (!householdId || principal.householdId !== householdId) {
      sendJson(response, 403, { error: "forbidden" });
      return;
    }

    sendJson(response, 200, { members: await listMembers(householdId) });
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    console.error("Unhandled request error", error);
    if (!response.headersSent) {
      sendJson(response, 500, { error: "internal_error" });
    } else if (!response.writableEnded) {
      response.end();
    }
  });
});

server.listen(config.port, config.host, () => {
  console.log(`SOL Core listening on http://${config.host}:${config.port}`);
  if (config.host !== "127.0.0.1" && config.host !== "localhost") {
    console.warn(
      "SOL is listening beyond localhost. Use HTTPS and review member authentication before exposing it broadly.",
    );
  }
});

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down SOL Core`);
  server.close(async () => {
    await closeDatabase();
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
