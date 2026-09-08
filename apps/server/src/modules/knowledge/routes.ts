import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "../../http.js";
import type { AuthPrincipal } from "../auth/session.js";
import {
  linkIdentityToCanonicalPerson,
  listCanonicalPeople,
  PersonLinkValidationError,
} from "../identity/person-links.js";
import { handleMemoryApi } from "../memory/routes.js";
import {
  createKnowledgeEntity,
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
  if (path.startsWith("/v1/knowledge/memory")) {
    return handleMemoryApi(path, request, response, principal);
  }

  if (path === "/v1/knowledge/people" && request.method === "GET") {
    sendJson(response, 200, { people: await listCanonicalPeople(principal) });
    return true;
  }

  const personLinkMatch = path.match(
    /^\/v1\/knowledge\/people\/([0-9a-f-]{36})\/identities\/([0-9a-f-]{36})$/i,
  );
  if (personLinkMatch) {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    try {
      sendJson(response, 200, {
        link: await linkIdentityToCanonicalPerson(
          principal,
          personLinkMatch[2]!,
          personLinkMatch[1]!,
        ),
      });
    } catch (error) {
      if (error instanceof PersonLinkValidationError) {
        const status = error.message === "person_link_forbidden" ? 403
          : error.message.endsWith("_not_found") ? 404
            : 400;
        sendJson(response, status, { error: error.message });
        return true;
      }
      throw error;
    }
    return true;
  }

  if (path !== "/v1/knowledge/entities") return false;

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
