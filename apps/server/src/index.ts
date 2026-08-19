import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config.js";
import { InMemoryEventBus } from "./core/event-bus.js";
import { checkDatabase, closeDatabase } from "./database/client.js";
import { readJsonBody, sendHtml, sendJson } from "./http.js";
import {
  AlreadyConfiguredError,
  ValidationError,
  bootstrapHousehold,
  getOnboardingState,
  listMembers,
  type BootstrapInput,
} from "./modules/identity/repository.js";
import { renderOnboardingPage } from "./ui/onboarding.js";

export const eventBus = new InMemoryEventBus();

function pathname(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://sol.local").pathname;
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
    if (!request.headers["content-type"]?.includes("application/json")) {
      sendJson(response, 415, { error: "content-type must be application/json" });
      return;
    }

    try {
      const input = await readJsonBody<BootstrapInput>(request);
      const result = await bootstrapHousehold(input);
      sendJson(response, 201, result);
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

  const membersMatch = path.match(
    /^\/v1\/households\/([0-9a-f-]{36})\/members$/i,
  );
  if (request.method === "GET" && membersMatch) {
    const householdId = membersMatch[1];
    if (!householdId) {
      sendJson(response, 400, { error: "invalid household id" });
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
      "SOL is listening beyond localhost before member authentication is implemented.",
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
