import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { config } from "../config.js";
import { authenticateMcpAccess } from "../modules/mcp/access.js";
import { readOpenAiBridgeState, writeOpenAiBridgeState, type OpenAiBridgeState } from "./openai-bridge-state.js";

const CORE_READ = new Set([
  "sol_status",
  "nexo_status",
  "get_timeline",
  "search_life",
  "search_whatsapp",
  "get_attention_queue",
  "list_people",
  "list_projects",
  "memory_search",
]);
const CORE_SUBMIT = new Set([
  "save_observation",
  "remember_fact",
  "correct_memory",
  "forget_memory",
  "save_schedule",
]);

async function loadMcpToken(): Promise<string> {
  const direct = process.env.SOL_MCP_TOKEN?.trim() || process.env.NEXO_MCP_TOKEN?.trim();
  if (direct) return direct;
  const file = process.env.SOL_MCP_TOKEN_FILE?.trim() || process.env.NEXO_MCP_TOKEN_FILE?.trim();
  if (file) return (await readFile(file, "utf8")).trim();
  throw new Error("SOL OpenAI bridge requires SOL_MCP_TOKEN or SOL_MCP_TOKEN_FILE");
}

function gatewayUrl(): string {
  const value = process.env.SOL_OPENAI_GATEWAY_URL?.trim().replace(/\/$/, "");
  if (!value) throw new Error("SOL_OPENAI_GATEWAY_URL is required");
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw new Error("SOL_OPENAI_GATEWAY_URL must use HTTPS outside local development");
  }
  return url.toString().replace(/\/$/, "");
}

function bridgeScopes(): Array<"read" | "submit" | "actions"> {
  const raw = process.env.SOL_OPENAI_BRIDGE_SCOPES?.trim() || "read,submit,actions";
  const allowed = new Set(["read", "submit", "actions"]);
  const values = raw.split(/[\s,]+/).filter((value) => allowed.has(value));
  return [...new Set(["read", ...values])] as Array<"read" | "submit" | "actions">;
}

function inheritedEnv(token: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[name] = value;
  }
  env.SOL_MCP_TOKEN = token;
  return env;
}

function stdioCommand(): { command: string; args: string[] } {
  const custom = process.env.SOL_MCP_BRIDGE_STDIO_COMMAND?.trim();
  const argsRaw = process.env.SOL_MCP_BRIDGE_STDIO_ARGS?.trim();
  if (custom) {
    let args: string[] = [];
    if (argsRaw) {
      const parsed = JSON.parse(argsRaw);
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error("SOL_MCP_BRIDGE_STDIO_ARGS must be a JSON string array");
      args = parsed;
    }
    return { command: custom, args };
  }
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL("./nexo-stdio.js", import.meta.url))],
  };
}

function title(name: string): string {
  return name.split("_").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function requiredScope(tool: any): "read" | "submit" | "actions" {
  if (CORE_READ.has(tool.name)) return "read";
  if (CORE_SUBMIT.has(tool.name)) return "submit";
  if (tool.annotations?.readOnlyHint === true) return "read";
  return "actions";
}

function parseTextResult(result: any): unknown {
  const part = Array.isArray(result?.content) ? result.content.find((item: any) => item?.type === "text" && typeof item.text === "string") : undefined;
  if (!part) return undefined;
  try { return JSON.parse(part.text); } catch { return part.text; }
}

async function main(): Promise<void> {
  const token = await loadMcpToken();
  async function assertMcpAccessActive(): Promise<void> {
    if (!(await authenticateMcpAccess(token))) {
      throw new Error("SOL MCP access was revoked, expired or disabled; stopping the OpenAI bridge");
    }
  }
  await assertMcpAccessActive();
  const gateway = gatewayUrl();
  const command = stdioCommand();
  const client = new Client({ name: "sol-openai-plugin-bridge", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: command.command,
    args: command.args,
    env: inheritedEnv(token),
  });
  await client.connect(transport);

  const listed: any = await client.listTools();
  const tools = (listed.tools ?? []).map((tool: any) => ({
    name: tool.name,
    title: tool.title || title(tool.name),
    description: tool.description || `SOL tool ${tool.name}`,
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    annotations: tool.annotations ?? undefined,
    requiredScope: requiredScope(tool),
  }));

  const statusResult: any = await client.callTool({ name: "sol_status", arguments: {} }).catch(() => undefined);
  const status = parseTextResult(statusResult) as any;
  const profile = status && typeof status === "object" ? {
    displayName: status.member?.displayName,
    memberRole: status.member?.role,
    solVersion: process.env.SOL_VERSION,
  } : undefined;

  let state = await readOpenAiBridgeState();
  if (!state || state.gatewayUrl !== gateway) {
    state = {
      gatewayUrl: gateway,
      instanceId: "",
      bridgeToken: "",
    };
  }

  async function request(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const headers = new Headers(init.headers);
    if (state?.bridgeToken) headers.set("authorization", `Bearer ${state.bridgeToken}`);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(`${gateway}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(70_000),
    });
    if (response.status === 401 && retry) {
      await enroll(true);
      return await request(path, init, false);
    }
    return response;
  }

  async function enroll(force = false): Promise<void> {
    if (!force && state?.bridgeToken && state.instanceId) return;
    const response = await fetch(`${gateway}/bridge/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Bridge enrollment failed: HTTP ${response.status}`);
    const body = await response.json() as { instanceId?: string; bridgeToken?: string };
    if (!body.instanceId || !body.bridgeToken) throw new Error("Bridge enrollment returned incomplete credentials");
    state = {
      ...(state ?? { gatewayUrl: gateway, instanceId: "", bridgeToken: "" }),
      gatewayUrl: gateway,
      instanceId: body.instanceId,
      bridgeToken: body.bridgeToken,
    };
    await writeOpenAiBridgeState(state);
  }

  async function publishCatalog(): Promise<void> {
    await assertMcpAccessActive();
    await enroll();
    const response = await request("/bridge/catalog", {
      method: "POST",
      body: JSON.stringify({ tools, profile }),
    });
    if (!response.ok) throw new Error(`Catalog publish failed: HTTP ${response.status}`);
    state = {
      ...state!,
      lastCatalogAt: new Date().toISOString(),
      toolCount: tools.length,
      profile,
    };
    await writeOpenAiBridgeState(state);
  }

  async function refreshPairCode(): Promise<void> {
    const response = await request("/bridge/pair-code", {
      method: "POST",
      body: JSON.stringify({ scopes: bridgeScopes() }),
    });
    if (!response.ok) throw new Error(`Pair code request failed: HTTP ${response.status}`);
    const body = await response.json() as { code?: string; expiresAt?: string };
    if (!body.code || !body.expiresAt) throw new Error("Pair code response incomplete");
    state = {
      ...state!,
      pairCode: body.code,
      pairExpiresAt: body.expiresAt,
    };
    await writeOpenAiBridgeState(state);
    console.log(`ChatGPT ↔ SOL pairing code: ${body.code} (expires ${body.expiresAt})`);
  }

  await enroll();
  await publishCatalog();
  await refreshPairCode();

  let lastCatalog = Date.now();
  let lastPair = Date.now();

  const stop = new AbortController();
  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}; stopping SOL OpenAI bridge`);
    stop.abort();
    await client.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  while (!stop.signal.aborted) {
    const now = Date.now();
    if (now - lastCatalog >= 30_000) {
      await publishCatalog().catch((error) => console.error("Failed to refresh SOL tool catalog", error));
      lastCatalog = now;
    }
    if (now - lastPair >= 4 * 60_000) {
      await refreshPairCode().catch((error) => console.error("Failed to refresh pairing code", error));
      lastPair = now;
    }

    const response = await request("/bridge/jobs?wait=25000", {
      method: "GET",
      signal: AbortSignal.timeout(35_000),
    }).catch((error) => {
      console.error("Bridge poll failed", error);
      return undefined;
    });
    if (!response) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    if (response.status === 204) continue;
    if (!response.ok) {
      console.error(`Bridge poll returned HTTP ${response.status}`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }

    const job = await response.json() as { id?: string; tool?: string; arguments?: Record<string, unknown> };
    if (!job.id || !job.tool) continue;
    try {
      await assertMcpAccessActive();
    } catch (cause) {
      console.error(cause instanceof Error ? cause.message : String(cause));
      await client.close().catch(() => undefined);
      process.exit(2);
    }
    let result: unknown;
    let ok = true;
    let error: string | undefined;
    try {
      result = await client.callTool({ name: job.tool, arguments: job.arguments ?? {} });
    } catch (cause) {
      ok = false;
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const submit = await request(`/bridge/jobs/${encodeURIComponent(job.id)}/result`, {
      method: "POST",
      body: JSON.stringify(ok ? { ok: true, result } : { ok: false, error }),
    }).catch(() => undefined);
    if (!submit?.ok) console.error(`Failed to submit result for ${job.id}`);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
