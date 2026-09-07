import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "../../http.js";
import type { AuthPrincipal } from "../auth/session.js";
import { handleMemoryApi } from "../memory/routes.js";
import {
  createKnowledgeEntity,
  deleteKnowledgeEntity,
  KnowledgeValidationError,
  listKnowledgeEntities,
  type KnowledgeViewKind,
} from "./views.js";

export async function handleKnowledgeApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthPrincipal,
): Promise<boolean> {
  if (path.startsWith("/v1/knowledge/memory")) return handleMemoryApi(path, request, response, principal);

  if (path === "/v1/knowledge/entities") {
    if (request.method === "GET") {
      const url = new URL(request.url ?? path, "http://sol.local");
      const kind = url.searchParams.get("kind") as KnowledgeViewKind | null;
      if (kind !== "person" && kind !== "project") {
        sendJson(response, 400, { error: "kind must be person or project" });
        return true;
      }
      sendJson(response, 200, { entities: await listKnowledgeEntities(principal, kind) });
      return true;
    }
    if (request.method === "POST") {
      if (!request.headers["content-type"]?.includes("application/json")) {
        sendJson(response, 415, { error: "content-type must be application/json" });
        return true;
      }
      try {
        const input = await readJsonBody<{ kind?: string; name?: string; visibility?: string }>(request);
        sendJson(response, 201, { entity: await createKnowledgeEntity(principal, input) });
      } catch (error) {
        if (error instanceof KnowledgeValidationError) {
          sendJson(response, 400, { error: error.message });
          return true;
        }
        throw error;
      }
      return true;
    }
    return false;
  }

  const entityMatch = path.match(/^\/v1\/knowledge\/entities\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (entityMatch && request.method === "DELETE") {
    try {
      const deleted = await deleteKnowledgeEntity(principal, entityMatch[1]!);
      sendJson(response, deleted ? 200 : 404, deleted ? { ok: true } : { error: "entity_not_found" });
    } catch (error) {
      if (error instanceof KnowledgeValidationError) {
        sendJson(response, 403, { error: error.message });
        return true;
      }
      throw error;
    }
    return true;
  }

  return false;
}
