import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "../../http.js";
import type { AuthPrincipal } from "../auth/session.js";
import {
  linkIdentityToCanonicalPerson,
  listCanonicalPeople,
  PersonLinkValidationError,
} from "./person-links.js";

export async function handlePersonLinksApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthPrincipal,
): Promise<boolean> {
  if (path === "/v1/people" && request.method === "GET") {
    sendJson(response, 200, { people: await listCanonicalPeople(principal) });
    return true;
  }

  const match = path.match(
    /^\/v1\/people\/([0-9a-f-]{36})\/identities\/([0-9a-f-]{36})$/i,
  );
  if (!match) return false;
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "method_not_allowed" });
    return true;
  }
  if (!request.headers["content-type"]?.includes("application/json")) {
    sendJson(response, 415, { error: "content-type must be application/json" });
    return true;
  }

  try {
    const body = await readJsonBody<Record<string, never>>(request).catch(() => ({}));
    void body;
    const personEntityId = match[1]!;
    const identityId = match[2]!;
    sendJson(response, 200, {
      link: await linkIdentityToCanonicalPerson(principal, identityId, personEntityId),
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
