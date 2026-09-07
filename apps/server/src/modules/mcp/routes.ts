import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../../config.js";
import { readJsonBody, sendJson } from "../../http.js";
import type { AuthPrincipal } from "../auth/session.js";
import { createMcpAccessToken, listMcpAccessTokens, revokeMcpAccessToken } from "./access.js";

function mcpClientCommand(): { command: string; args: string[]; mode: "portable" | "development" } {
  const portableNode = resolve(config.repoRoot, "runtime", process.platform === "win32" ? "node.exe" : "node");
  const compiledEntry = resolve(config.repoRoot, "apps", "server", "dist", "mcp", "sol-stdio.js");
  if (existsSync(portableNode) && existsSync(compiledEntry)) return { command: portableNode, args: [compiledEntry], mode: "portable" };
  return { command: "pnpm", args: ["--dir", config.repoRoot, "mcp"], mode: "development" };
}

export async function handleMcpApi(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthPrincipal,
): Promise<boolean> {
  if (path === "/v1/mcp/status" && request.method === "GET") {
    const clientCommand = mcpClientCommand();
    sendJson(response, 200, {
      product: "SOL",
      enabled: true,
      transport: "stdio",
      protocol: "2026-07-28 target · 2025-era compatible",
      protocolTarget: "2026-07-28",
      protocolNegotiation: "serveStdio",
      mode: "SOL core tools + dynamically registered plugin tools",
      command: [clientCommand.command, ...clientCommand.args].join(" "),
      clientCommand,
      repoRoot: config.repoRoot,
      env: "SOL_MCP_TOKEN",
      coreTools: [
        "sol_status", "get_timeline", "search_life", "list_people", "list_projects", "memory_search",
        "save_observation (requires submit scope)", "remember_fact (requires submit scope)",
        "correct_memory (requires submit scope)", "forget_memory (requires submit scope)",
        "save_schedule (requires submit scope)",
      ],
      pluginTools: "dynamic_from_running_plugins",
      runtime: { externalSources: "plugins-only", externalCapabilities: "plugins-register-through-sol" },
      submissionPolicy: {
        userConfirmedMemoryWrites: true,
        pluginActionsRequireExplicitExternalActionScope: true,
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
      const body = await readJsonBody<{ label?: string; expiresInDays?: number; allowSubmit?: boolean; allowExternalActions?: boolean }>(request);
      sendJson(response, 201, await createMcpAccessToken(principal, body));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  const match = path.match(/^\/v1\/mcp\/tokens\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
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
