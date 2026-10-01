import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../../config.js";
import { readJsonBody, sendJson } from "../../http.js";
import type { AuthPrincipal } from "../auth/session.js";
import {
  createMcpAccessToken,
  listMcpAccessTokens,
  revokeMcpAccessToken,
} from "./access.js";
import { publicOpenAiBridgeState } from "../../mcp/openai-bridge-state.js";

export async function handleMcpApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthPrincipal,
): Promise<boolean> {
  if (path === "/v1/mcp/status" && request.method === "GET") {
    sendJson(response, 200, {
      product: "SOL",
      enabled: true,
      transport: "stdio",
      remoteTransport: "openai_secure_mcp_tunnel",
      protocol: "2026-07-28 target · 2025-era compatible",
      protocolTarget: "2026-07-28",
      protocolNegotiation: "serveStdio",
      mode: "member-scoped data, memory and plugin tools for MCP clients",
      command: "pnpm mcp",
      portableCommand: "scripts/windows/sol-mcp.ps1",
      repoRoot: config.repoRoot,
      env: "SOL_MCP_TOKEN",
      tokenFileEnv: "SOL_MCP_TOKEN_FILE",
      tools: [
        "sol_status",
        "sol_request (high-level natural-language router; actions require explicit confirmation + actions scope)",
        "get_timeline",
        "search_life",
        "search_whatsapp",
        "get_attention_queue",
        "list_people",
        "list_projects",
        "memory_search",
        "save_observation (requires submit scope)",
        "remember_fact (requires submit scope)",
        "save_schedule (requires submit scope)",
        "plugin read tools (require matching scope)",
        "plugin external actions (require actions scope)",
      ],
      chatgpt: {
        tunnelReady: true,
        localTransport: "stdio",
        publicListenerRequired: false,
        pluginToolsIncluded: true,
        publicPluginBridge: {
          launcher: "scripts/windows/sol-openai-bridge.ps1",
          gatewayEnv: "SOL_OPENAI_GATEWAY_URL",
          scopesEnv: "SOL_OPENAI_BRIDGE_SCOPES",
          status: await publicOpenAiBridgeState(),
        },
      },
      runtime: { externalSources: "plugins-only" },
      submissionPolicy: {
        userConfirmedMemoryWrites: true,
        externalActionsRequireScope: "actions",
        lifeProvenanceRequired: true,
        retrievedContentCannotAuthorizeWrites: true,
      },
    });
    return true;
  }

  if (path === "/v1/mcp/openai-bridge/status" && request.method === "GET") {
    sendJson(response, 200, await publicOpenAiBridgeState());
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
      const body = await readJsonBody<{
        label?: string;
        expiresInDays?: number;
        allowSubmit?: boolean;
        allowActions?: boolean;
      }>(request);
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
