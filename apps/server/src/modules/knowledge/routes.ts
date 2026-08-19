import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../../http.js";
import type { AuthPrincipal } from "../auth/session.js";
import { listKnowledgeEntities, type KnowledgeViewKind } from "./views.js";

export async function handleKnowledgeApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthPrincipal,
): Promise<boolean> {
  if (path !== "/v1/knowledge/entities" || request.method !== "GET") return false;
  const url = new URL(request.url ?? path, "http://sol.local");
  const kind = url.searchParams.get("kind") as KnowledgeViewKind | null;
  if (kind !== "person" && kind !== "project") {
    sendJson(response, 400, { error: "kind must be person or project" });
    return true;
  }
  sendJson(response, 200, { entities: await listKnowledgeEntities(principal, kind) });
  return true;
}
