import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../../config.js";
import { db } from "../../database/client.js";
import { readJsonBody, sendJson } from "../../http.js";
import type { AuthPrincipal } from "../auth/session.js";
import {
  getCodexStatus,
  logoutCodex,
  startCodexLogin,
} from "./codex/account.js";
import { codexAppServer } from "./codex/runtime.js";
import type { ReasoningRequest } from "./provider.js";
import { aiProvider } from "./runtime.js";

function canManageAi(principal: AuthPrincipal): boolean {
  return principal.role === "owner" || principal.role === "adult";
}

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

export async function handleAiApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthPrincipal,
): Promise<boolean> {
  if (request.method === "GET" && path === "/v1/ai/status") {
    const [router, codex] = await Promise.all([
      aiProvider.status(),
      getCodexStatus(codexAppServer),
    ]);
    const openai = router.providers.find((item) => item.id === "openai");
    const codexAvailability = router.providers.find((item) => item.id === "codex");
    sendJson(response, 200, {
      mode: router.mode,
      activeProvider: router.activeProvider,
      available: Boolean(router.activeProvider),
      providers: {
        openai: {
          configured: openai?.configured ?? false,
          available: openai?.available ?? false,
          model: config.openaiModel,
          fastModel: config.openaiFastModel,
          baseUrl: config.openaiBaseUrl,
        },
        codex: {
          ...codex,
          configured: codexAvailability?.configured ?? true,
          available: codexAvailability?.available ?? false,
        },
      },
    });
    return true;
  }

  if (request.method === "POST" && path === "/v1/ai/codex/login") {
    if (!canManageAi(principal)) {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }

    const body = await readJson<{ flow?: "browser" | "device" }>(request, response);
    if (!body) return true;

    try {
      const login = await startCodexLogin(codexAppServer, body.flow ?? "browser");
      sendJson(response, 200, { login });
    } catch (error) {
      sendJson(response, 503, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (request.method === "POST" && path === "/v1/ai/codex/logout") {
    if (!canManageAi(principal)) {
      sendJson(response, 403, { error: "forbidden" });
      return true;
    }
    try {
      await logoutCodex(codexAppServer);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 503, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (request.method === "POST" && path === "/v1/ai/test") {
    const body = await readJson<{ message?: string }>(request, response);
    if (!body) return true;

    const householdResult = await db.query<{
      name: string;
      timezone: string;
    }>("SELECT name, timezone FROM households WHERE id = $1 LIMIT 1", [
      principal.householdId,
    ]);
    const household = householdResult.rows[0];
    if (!household) {
      sendJson(response, 404, { error: "household_not_found" });
      return true;
    }

    const requestData: ReasoningRequest = {
      householdId: principal.householdId,
      memberId: principal.memberId,
      purpose: "conversation",
      instructions:
        body.message?.trim() ||
        "Introduce yourself briefly as SOL and explain that you are connected as an optional household reasoning engine.",
      context: {
        household: {
          name: household.name,
          timezone: household.timezone,
        },
        currentMember: {
          displayName: principal.displayName,
          role: principal.role,
        },
      },
    };

    try {
      const result = await aiProvider.reason(requestData);
      sendJson(response, 200, { result });
    } catch (error) {
      sendJson(response, 503, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  return false;
}
