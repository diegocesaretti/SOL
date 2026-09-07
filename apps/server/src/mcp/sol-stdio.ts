import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { config } from "../config.js";
import { closeDatabase } from "../database/client.js";
import { authenticateMcpAccess } from "../modules/mcp/access.js";
import {
  getMcpStatus,
  getMcpTimeline,
  listMcpKnowledge,
  searchMcpLife,
} from "../modules/mcp/data.js";
import { rememberMcpFact } from "../modules/mcp/memory.js";
import { submitMcpInformation, submitMcpSchedule } from "../modules/mcp/submissions.js";
import { correctMemoryFact, forgetMemoryFact, searchMemories } from "../modules/memory/service.js";

interface PluginToolArgument {
  name: string;
  type: "string" | "number" | "boolean" | "string_array";
  description?: string;
  required: boolean;
  min?: number;
  max?: number;
  enum?: string[];
  literalTrue?: boolean;
}

interface PluginTool {
  pluginId: string;
  name: string;
  description: string;
  requiresSubmit: boolean;
  input: PluginToolArgument[];
}

const PLUGIN_TOOL_TIMEOUT_MS = 130_000;

async function loadToken(): Promise<string> {
  const direct = process.env.SOL_MCP_TOKEN?.trim() || process.env.NEXO_MCP_TOKEN?.trim();
  if (direct) return direct;
  const file = process.env.SOL_MCP_TOKEN_FILE?.trim() || process.env.NEXO_MCP_TOKEN_FILE?.trim();
  if (file) return (await readFile(file, "utf8")).trim();
  throw new Error("SOL MCP requires SOL_MCP_TOKEN (NEXO_MCP_TOKEN remains supported for compatibility)");
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function coreUrl(): string {
  const explicit = process.env.SOL_CORE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
  return `http://${host}:${config.port}`;
}

async function pluginRequest<T>(
  token: string,
  path: string,
  options: RequestInit = {},
  timeoutMs = 20_000,
): Promise<T> {
  const response = await fetch(`${coreUrl()}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const reason = typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
    throw new Error(reason);
  }
  return payload as T;
}

function argumentSchema(argument: PluginToolArgument): any {
  let schema: any;
  if (argument.type === "boolean") {
    schema = argument.literalTrue ? z.literal(true) : z.boolean();
  } else if (argument.type === "number") {
    schema = z.number();
    if (argument.min !== undefined) schema = schema.min(argument.min);
    if (argument.max !== undefined) schema = schema.max(argument.max);
  } else if (argument.type === "string_array") {
    schema = z.array(z.string());
    if (argument.min !== undefined) schema = schema.min(argument.min);
    if (argument.max !== undefined) schema = schema.max(argument.max);
  } else {
    schema = z.string();
    if (argument.min !== undefined) schema = schema.min(argument.min);
    if (argument.max !== undefined) schema = schema.max(argument.max);
    if (argument.enum?.length) {
      const allowed = new Set(argument.enum);
      schema = schema.refine((value: string) => allowed.has(value), { message: `Expected one of: ${argument.enum.join(", ")}` });
    }
  }
  if (argument.description) schema = schema.describe(argument.description);
  return argument.required ? schema : schema.optional();
}

async function main(): Promise<void> {
  const token = await loadToken();
  const access = await authenticateMcpAccess(token);
  if (!access) throw new Error("SOL MCP authentication failed: token is invalid, expired, revoked, or member is inactive");
  const { principal, scopes } = access;
  const pluginTools = await pluginRequest<{ tools: PluginTool[] }>(token, "/v1/mcp/runtime/tools").catch((error) => {
    console.error(`SOL MCP could not discover plugin tools: ${error instanceof Error ? error.message : String(error)}`);
    return { tools: [] };
  });

  serveStdio(() => {
    const server = new McpServer({ name: "sol", version: "0.13.0" });

    server.registerTool("sol_status", {
      description: "Describe the authenticated SOL member, visible source inventory, knowledge/memory state, MCP scopes and installed plugin-tool architecture.",
      inputSchema: z.object({}),
    }, async () => {
      const status = await getMcpStatus(principal);
      return text({
        product: "SOL",
        role: "family/personal context, memory and plugin capability hub",
        member: status.member,
        sources: status.sources,
        knowledge: status.knowledge,
        recentTimelineItems: status.recentTimelineItems,
        mcpScopes: scopes,
        pluginTools: pluginTools.tools.map((tool) => ({ name: tool.name, pluginId: tool.pluginId })),
        policy: {
          privateDataIsMemberScoped: true,
          externalProvidersArePlugins: true,
          oneExternalMcp: "SOL",
          userConfirmedWrites: true,
          provenanceRequired: true,
        },
      });
    });

    server.registerTool("get_timeline", {
      description: "Return the authenticated member's permission-filtered SOL Life timeline.",
      inputSchema: z.object({ limit: z.number().int().min(10).max(120).optional(), before: z.string().datetime({ offset: true }).optional() }),
    }, async ({ limit, before }) => text(await getMcpTimeline(principal, { limit, before })));

    server.registerTool("search_life", {
      description: "Search permission-filtered SOL Life observations and durable local records across plugin-ingested sources.",
      inputSchema: z.object({ query: z.string().min(2).max(240), limit: z.number().int().min(1).max(60).optional() }),
    }, async ({ query, limit }) => text(await searchMcpLife(principal, query, limit)));

    server.registerTool("list_people", {
      description: "List or filter Person entities and visible durable facts stored in SOL.",
      inputSchema: z.object({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).optional() }),
    }, async ({ query, limit }) => text(await listMcpKnowledge(principal, "person", query, limit)));

    server.registerTool("list_projects", {
      description: "List or filter Project entities and visible durable facts stored in SOL.",
      inputSchema: z.object({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).optional() }),
    }, async ({ query, limit }) => text(await listMcpKnowledge(principal, "project", query, limit)));

    server.registerTool("memory_search", {
      description: "Search explicit durable SOL memories visible to the authenticated member, including provenance and current status.",
      inputSchema: z.object({ query: z.string().max(240).optional(), limit: z.number().int().min(1).max(100).optional(), includeInactive: z.boolean().optional() }),
    }, async ({ query, limit, includeInactive }) => text(await searchMemories(principal, { query, limit, includeInactive })));

    if (scopes.includes("submit")) {
      server.registerTool("save_observation", {
        description: "Save information the current authenticated human explicitly asked SOL to preserve as a provenance-bearing Life observation.",
        inputSchema: z.object({
          confirmedByUser: z.literal(true),
          title: z.string().min(1).max(180).optional(),
          text: z.string().min(1).max(24_000),
          context: z.string().max(1000).optional(),
          visibility: z.enum(["private", "family"]).optional(),
        }),
      }, async ({ title, text: information, context, visibility }) => text(await submitMcpInformation(principal, { title, text: information, context, visibility })));

      server.registerTool("remember_fact", {
        description: "Store one durable structured SOL memory only when the current human explicitly confirms it.",
        inputSchema: z.object({
          confirmedByUser: z.literal(true),
          entityKind: z.enum(["person", "organization", "place", "project", "product", "topic", "other"]),
          entityName: z.string().min(1).max(180),
          predicate: z.string().min(1).max(120),
          value: z.unknown(),
          visibility: z.enum(["private", "family"]).optional(),
          replaceExisting: z.boolean().optional(),
          evidenceSourceItemIds: z.array(z.string().uuid()).max(20).optional(),
        }),
      }, async ({ entityKind, entityName, predicate, value, visibility, replaceExisting, evidenceSourceItemIds }) => text(await rememberMcpFact(principal, {
        entityKind, entityName, predicate, value, visibility, replaceExisting, evidenceSourceItemIds,
      })));

      server.registerTool("correct_memory", {
        description: "Correct one explicit SOL memory owned by the authenticated human while retaining superseded provenance.",
        inputSchema: z.object({ confirmedByUser: z.literal(true), factId: z.string().uuid(), value: z.unknown(), evidenceSourceItemIds: z.array(z.string().uuid()).max(20).optional() }),
      }, async ({ factId, value, evidenceSourceItemIds }) => text(await correctMemoryFact(principal, factId, {
        value,
        evidenceSourceItemIds,
        source: { channel: "sol", label: `SOL · ${principal.displayName}` },
      })));

      server.registerTool("forget_memory", {
        description: "Forget one active explicit SOL memory owned by the authenticated human while retaining audit provenance.",
        inputSchema: z.object({ confirmedByUser: z.literal(true), factId: z.string().uuid() }),
      }, async ({ factId }) => text(await forgetMemoryFact(principal, factId)));

      server.registerTool("save_schedule", {
        description: "Store a recurring schedule the current authenticated human explicitly asked SOL to remember. This does not create external calendar events.",
        inputSchema: z.object({
          confirmedByUser: z.literal(true),
          person: z.string().min(1).max(180),
          scheduleName: z.string().min(1).max(120).optional(),
          visibility: z.enum(["private", "family"]).optional(),
          timezone: z.string().min(1).max(100).optional(),
          validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          replaceExisting: z.boolean().optional(),
          entries: z.array(z.object({
            day: z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]),
            start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
            end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
            title: z.string().min(1).max(180),
            location: z.string().max(180).optional(),
            notes: z.string().max(500).optional(),
          })).min(1).max(80),
        }),
      }, async ({ person, scheduleName, visibility, timezone, validFrom, validUntil, replaceExisting, entries }) => text(await submitMcpSchedule(principal, {
        person, scheduleName, visibility, timezone, validFrom, validUntil, replaceExisting, entries,
      })));
    }

    for (const tool of pluginTools.tools) {
      const shape: Record<string, any> = {};
      for (const argument of tool.input) shape[argument.name] = argumentSchema(argument);
      server.registerTool(tool.name, {
        description: `${tool.description} [plugin: ${tool.pluginId}]`,
        inputSchema: z.object(shape),
      }, async (input) => {
        const payload = await pluginRequest<{ result: unknown }>(
          token,
          `/v1/mcp/runtime/tools/${encodeURIComponent(tool.name)}/call`,
          { method: "POST", body: JSON.stringify(input) },
          PLUGIN_TOOL_TIMEOUT_MS,
        );
        return text(payload.result);
      });
    }

    return server;
  });
}

void main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  await closeDatabase().catch(() => undefined);
  process.exit(1);
});
