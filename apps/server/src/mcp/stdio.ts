import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { authenticateMcpToken } from "../modules/mcp/access.js";
import {
  getMcpBusinessSummary,
  getMcpHomeState,
  getMcpStatus,
  getMcpTimeline,
  listMcpKnowledge,
  searchMcpLife,
} from "../modules/mcp/data.js";

async function loadToken(): Promise<string> {
  const direct = process.env.SOL_MCP_TOKEN?.trim();
  if (direct) return direct;
  const file = process.env.SOL_MCP_TOKEN_FILE?.trim();
  if (file) return (await readFile(file, "utf8")).trim();
  throw new Error("SOL MCP requires SOL_MCP_TOKEN or SOL_MCP_TOKEN_FILE");
}

function text(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

const principal = await authenticateMcpToken(await loadToken());
if (!principal) {
  console.error("SOL MCP authentication failed: token is invalid, expired, revoked, or member is inactive");
  process.exitCode = 1;
} else {
  serveStdio(() => {
    const server = new McpServer({ name: "sol", version: "0.9.0" });

    server.registerTool(
      "sol_status",
      {
        description:
          "Describe the authenticated SOL member, visible source inventory, knowledge counts and read-only privacy policy.",
        inputSchema: z.object({}),
      },
      async () => text(await getMcpStatus(principal)),
    );

    server.registerTool(
      "get_timeline",
      {
        description:
          "Return the authenticated member's permission-filtered SOL Life timeline. Private records of other members are never retrieved.",
        inputSchema: z.object({
          limit: z.number().int().min(10).max(120).optional(),
          before: z.string().datetime({ offset: true }).optional(),
        }),
      },
      async ({ limit, before }) => text(await getMcpTimeline(principal, { limit, before })),
    );

    server.registerTool(
      "search_life",
      {
        description:
          "Search permission-filtered source items, Life events and tasks for text. Use this for finding remembered messages, events and tasks.",
        inputSchema: z.object({
          query: z.string().min(2).max(240),
          limit: z.number().int().min(1).max(60).optional(),
        }),
      },
      async ({ query, limit }) => text(await searchMcpLife(principal, query, limit)),
    );

    server.registerTool(
      "list_people",
      {
        description:
          "List or filter Person entities and their visible facts from SOL Knowledge for the authenticated member.",
        inputSchema: z.object({
          query: z.string().max(200).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        }),
      },
      async ({ query, limit }) => text(await listMcpKnowledge(principal, "person", query, limit)),
    );

    server.registerTool(
      "list_projects",
      {
        description:
          "List or filter Project entities and their visible facts from SOL Knowledge for the authenticated member.",
        inputSchema: z.object({
          query: z.string().max(200).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        }),
      },
      async ({ query, limit }) => text(await listMcpKnowledge(principal, "project", query, limit)),
    );

    server.registerTool(
      "get_home_state",
      {
        description:
          "Return current states of Home Assistant entities explicitly selected for SOL sync. This tool is read-only and cannot call services.",
        inputSchema: z.object({
          query: z.string().max(200).optional(),
          domain: z.string().max(80).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        }),
      },
      async ({ query, domain, limit }) =>
        text(await getMcpHomeState(principal, { query, domain, limit })),
    );

    server.registerTool(
      "get_business_summary",
      {
        description:
          "Return a compact permission-filtered Mercado Libre business summary for a recent period, without buyer addresses or raw credentials.",
        inputSchema: z.object({ days: z.number().int().min(1).max(90).optional() }),
      },
      async ({ days }) => text(await getMcpBusinessSummary(principal, days)),
    );

    return server;
  });
}
