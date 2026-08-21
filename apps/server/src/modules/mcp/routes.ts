import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../../config.js";
import { readJsonBody, sendJson } from "../../http.js";
import type { AuthPrincipal } from "../auth/session.js";
import {
  createMcpAccessToken,
  listMcpAccessTokens,
  revokeMcpAccessToken,
} from "./access.js";

export async function handleMcpApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthPrincipal,
): Promise<boolean> {
  if (path === "/v1/mcp/status" && request.method === "GET") {
    sendJson(response, 200, {
      product: "Nexo",
      enabled: true,
      transport: "stdio",
      protocol: "2026-07-28 target · 2025-era compatible",
      protocolTarget: "2026-07-28",
      protocolNegotiation: "serveStdio",
      mode: "context/memory for external Codex",
      command: "pnpm mcp",
      repoRoot: config.repoRoot,
      env: "NEXO_MCP_TOKEN",
      tools: [
        "nexo_status",
        "get_timeline",
        "search_life",
        "search_whatsapp",
        "get_attention_queue",
        "list_people",
        "list_projects",
        "save_observation (requires submit scope)",
        "remember_fact (requires submit scope)",
        "save_schedule (requires submit scope)",
      ],
      runtime: {
        internalAssistantBrain: config.nexoInternalAutomationEnabled,
        legacyBackgroundConnectors: config.nexoLegacyConnectorsEnabled,
      },
      submissionPolicy: {
        userConfirmedMemoryWrites: true,
        externalActions: false,
        lifeProvenanceRequired: true,
        retrievedContentCannotAuthorizeWrites: true,
      },
    });
    return true;
  }

  if (path === "/v1/mcp/tokens" && request.method === "GET") {
    sendJson(response, 200, { tokens: await listMcpAccessTokens(principal) });
    return true;
  }

  if (path === "/v1/mcp/tokens" && request.method === "POST") {
    if (!request.headers["content-type"]?.includes("application/json")) {
      sendJson(response, 415, { error: "content-type must be application/json" });
      return true;
    }
    try {
      const body = await readJsonBody<{ label?: string; expiresInDays?: number; allowSubmit?: boolean }>(request);
      sendJson(response, 201, await createMcpAccessToken(principal, body));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  const match = path.match(
    /^\/v1\/mcp\/tokens\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  );
  if (match && request.method === "DELETE") {
    const tokenId = match[1];
    if (!tokenId || !(await revokeMcpAccessToken(principal, tokenId))) {
      sendJson(response, 404, { error: "mcp_token_not_found" });
      return true;
    }
    sendJson(response, 200, { ok: true });
    return true;
  }

  return false;
}
