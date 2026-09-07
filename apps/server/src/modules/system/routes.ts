import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "../../http.js";
import type { AuthPrincipal } from "../auth/session.js";
import { getSystemAdminState, resetSol, SystemAdminError } from "./admin.js";

function error(response: ServerResponse, value: unknown): void {
  if (value instanceof SystemAdminError) {
    sendJson(response, value.status, { error: value.message });
    return;
  }
  throw value;
}

export async function handleSystemAdminApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthPrincipal,
): Promise<boolean> {
  if (path === "/v1/admin/system" && request.method === "GET") {
    try { sendJson(response, 200, await getSystemAdminState(principal)); }
    catch (value) { error(response, value); }
    return true;
  }

  if (path === "/v1/admin/reset" && request.method === "POST") {
    if (!request.headers["content-type"]?.includes("application/json")) {
      sendJson(response, 415, { error: "content-type must be application/json" });
      return true;
    }
    try {
      const input = await readJsonBody<{ mode?: string; confirmation?: string }>(request);
      sendJson(response, 200, await resetSol(principal, input));
    } catch (value) { error(response, value); }
    return true;
  }

  return false;
}
