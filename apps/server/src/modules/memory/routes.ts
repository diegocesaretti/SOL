import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "../../http.js";
import type { AuthPrincipal } from "../auth/session.js";
import {
  correctMemoryFact,
  forgetMemoryFact,
  rememberMemoryFact,
  searchMemories,
  type CorrectMemoryInput,
  type RememberMemoryInput,
} from "./service.js";

const BASE = "/v1/knowledge/memory";

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://sol.local");
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
    sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid request body" });
    return null;
  }
}

function memoryError(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "memory_not_found_or_not_owned") {
    sendJson(response, 404, { error: message });
    return;
  }
  sendJson(response, 400, { error: message });
}

export async function handleMemoryApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthPrincipal,
): Promise<boolean> {
  if (path === `${BASE}/search` && request.method === "GET") {
    const url = requestUrl(request);
    const limitRaw = Number(url.searchParams.get("limit") ?? "30");
    const includeInactive = url.searchParams.get("includeInactive") === "1";
    sendJson(response, 200, {
      memories: await searchMemories(principal, {
        query: url.searchParams.get("q") ?? undefined,
        limit: Number.isFinite(limitRaw) ? limitRaw : 30,
        includeInactive,
      }),
    });
    return true;
  }

  if (path === `${BASE}/remember` && request.method === "POST") {
    const body = await jsonBody<RememberMemoryInput & { confirmedByUser?: boolean }>(request, response);
    if (!body) return true;
    if (body.confirmedByUser !== true) {
      sendJson(response, 400, { error: "confirmedByUser=true is required for explicit memory writes" });
      return true;
    }
    try {
      const { confirmedByUser: _, ...input } = body;
      sendJson(response, 201, await rememberMemoryFact(principal, input));
    } catch (error) {
      memoryError(response, error);
    }
    return true;
  }

  const correction = path.match(/^\/v1\/knowledge\/memory\/([0-9a-f-]{36})\/correct$/i);
  if (correction && request.method === "POST") {
    const body = await jsonBody<CorrectMemoryInput & { confirmedByUser?: boolean }>(request, response);
    if (!body) return true;
    if (body.confirmedByUser !== true) {
      sendJson(response, 400, { error: "confirmedByUser=true is required for memory corrections" });
      return true;
    }
    try {
      const { confirmedByUser: _, ...input } = body;
      sendJson(response, 200, await correctMemoryFact(principal, correction[1]!, input));
    } catch (error) {
      memoryError(response, error);
    }
    return true;
  }

  const forgetting = path.match(/^\/v1\/knowledge\/memory\/([0-9a-f-]{36})\/forget$/i);
  if (forgetting && request.method === "POST") {
    const body = await jsonBody<{ confirmedByUser?: boolean }>(request, response);
    if (!body) return true;
    if (body.confirmedByUser !== true) {
      sendJson(response, 400, { error: "confirmedByUser=true is required to forget a memory" });
      return true;
    }
    try {
      sendJson(response, 200, await forgetMemoryFact(principal, forgetting[1]!));
    } catch (error) {
      memoryError(response, error);
    }
    return true;
  }

  return false;
}
