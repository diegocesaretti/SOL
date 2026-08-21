import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "../../http.js";
import type { AuthPrincipal } from "../auth/session.js";
import { buildExecutiveBrief, readExecutiveBrief } from "./briefs.js";
import {
  getProactivitySettings,
  updateProactivitySettings,
  type ProactivitySettings,
} from "./proactivity.js";
import {
  approveExecutiveProposal,
  listExecutiveProposals,
  rejectExecutiveProposal,
} from "./proposals.js";

async function readJson<T>(request: IncomingMessage, response: ServerResponse): Promise<T | null> {
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

function validProactivityPatch(value: unknown): value is Partial<ProactivitySettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const booleans = ["enabled", "morningBriefEnabled", "tomorrowPreviewEnabled", "suppressEmpty"];
  for (const key of booleans) {
    if (body[key] !== undefined && typeof body[key] !== "boolean") return false;
  }
  for (const key of ["morningTime", "tomorrowTime"]) {
    if (body[key] !== undefined && typeof body[key] !== "string") return false;
  }
  return true;
}

export async function handleExecutiveApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthPrincipal,
): Promise<boolean> {
  if (principal.role === "guest") {
    sendJson(response, 403, { error: "forbidden" });
    return true;
  }

  if (path === "/v1/executive/proactivity" && request.method === "GET") {
    sendJson(response, 200, {
      settings: await getProactivitySettings(principal.memberId),
    });
    return true;
  }

  if (path === "/v1/executive/proactivity" && request.method === "PATCH") {
    const body = await readJson<unknown>(request, response);
    if (body === null) return true;
    if (!validProactivityPatch(body)) {
      sendJson(response, 400, { error: "invalid_proactivity_settings" });
      return true;
    }
    try {
      const settings = await updateProactivitySettings(principal.memberId, body);
      sendJson(response, 200, { settings });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, message === "invalid_time" ? 400 : 503, { error: message });
    }
    return true;
  }

  if (path === "/v1/executive/proposals" && request.method === "GET") {
    const url = new URL(request.url ?? path, "http://sol.local");
    sendJson(response, 200, {
      proposals: await listExecutiveProposals({
        householdId: principal.householdId,
        memberId: principal.memberId,
        status: url.searchParams.get("status") || undefined,
      }),
    });
    return true;
  }

  if (path === "/v1/executive/brief" && request.method === "GET") {
    const url = new URL(request.url ?? path, "http://sol.local");
    const type = url.searchParams.get("type") === "tomorrow_preview" ? "tomorrow_preview" : "morning";
    const refresh = url.searchParams.get("refresh") === "1";
    try {
      const content = refresh
        ? await buildExecutiveBrief(principal.memberId, type)
        : (await readExecutiveBrief(principal.memberId, type)) ??
          (await buildExecutiveBrief(principal.memberId, type));
      sendJson(response, 200, { brief: content });
    } catch (error) {
      sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  const match = path.match(
    /^\/v1\/executive\/proposals\/([0-9a-f-]{36})\/(approve|reject)$/i,
  );
  if (!match || request.method !== "POST") return false;
  const proposalId = match[1];
  const action = match[2];
  if (!proposalId || !action) return false;

  if (action === "reject") {
    try {
      const rejected = await rejectExecutiveProposal({
        proposalId,
        householdId: principal.householdId,
        memberId: principal.memberId,
        role: principal.role,
      });
      if (!rejected) {
        sendJson(response, 404, { error: "proposal_not_found_or_not_rejectable" });
        return true;
      }
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 403, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  const body = await readJson<{
    targetSourceAccountId?: string;
    targetGoogleCalendarId?: string;
  }>(request, response);
  if (!body) return true;

  try {
    const result = await approveExecutiveProposal({
      proposalId,
      householdId: principal.householdId,
      memberId: principal.memberId,
      role: principal.role,
      targetSourceAccountId: body.targetSourceAccountId,
      targetGoogleCalendarId: body.targetGoogleCalendarId,
    });
    sendJson(response, 200, { result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = [
      "proposal_not_found_or_not_approvable",
      "calendar_target_required",
      "calendar_target_not_allowed",
      "event_time_required",
    ].includes(message)
      ? 409
      : 503;
    sendJson(response, status, { error: message });
  }
  return true;
}
