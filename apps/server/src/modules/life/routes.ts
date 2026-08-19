import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../../http.js";
import type { AuthPrincipal } from "../auth/session.js";
import { listTimeline } from "./timeline.js";

export async function handleLifeApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthPrincipal,
): Promise<boolean> {
  if (path !== "/v1/life/timeline" || request.method !== "GET") return false;
  const url = new URL(request.url ?? path, "http://sol.local");
  const limitRaw = Number(url.searchParams.get("limit") ?? 60);
  const limit = Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 60;
  sendJson(response, 200, await listTimeline(principal, {
    before: url.searchParams.get("before") ?? undefined,
    limit,
  }));
  return true;
}
