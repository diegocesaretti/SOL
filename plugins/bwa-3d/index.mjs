import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { SolPluginClientCore } from "./lib/sol-client-core.mjs";

function numberEnv(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value))) : fallback;
}
function boolEnv(name, fallback = false) {
  const value = process.env[name];
  return value === undefined ? fallback : /^(1|true|yes|on)$/i.test(value);
}
function sendJson(res, status, value) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}
async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > 1024 * 1024) throw new Error("request_too_large");
    chunks.push(b);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const config = {
  apiPort: numberEnv("BWA3D_SOL_API_PORT", 8781, 1024, 65535),
  site: process.env.BWA3D_ML_SITE?.trim() || "MLA",
  mcpUrl: process.env.BWA3D_ML_MCP_URL?.trim() || "https://mcp.mercadolibre.com/devsite/v1/mcp",
  clientId: process.env.BWA3D_ML_CLIENT_ID?.trim() || "",
  clientSecret: process.env.BWA3D_ML_CLIENT_SECRET?.trim() || "",
  redirectUri: process.env.BWA3D_ML_REDIRECT_URI?.trim() || "",
  allowWrite: boolEnv("BWA3D_ML_ALLOW_WRITE", false)
};

const pluginDataDir = process.env.SOL_PLUGIN_DATA_DIR?.trim()
  || join(process.env.SOL_PLUGIN_ROOT?.trim() || process.cwd(), ".data");
const authDir = join(pluginDataDir, "mercadolibre-mcp-auth");
const loginLogPath = join(pluginDataDir, "mercadolibre-mcp-login.log");

const sol = new SolPluginClientCore();
const pluginId = process.env.SOL_PLUGIN_ID?.trim() || "bwa-3d";
const mcpPath = `/mcp/${randomBytes(24).toString("base64url")}`;
const callbackUrl = `http://127.0.0.1:${config.apiPort}${mcpPath}`;

async function countFilesRecursive(dir) {
  let count = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) count += await countFilesRecursive(join(dir, entry.name));
      else count += 1;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return count;
}

async function tailText(file, maxChars = 1800) {
  try {
    const text = await readFile(file, "utf8");
    return text.slice(-maxChars);
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

let loginProcess = null;
let loginLastExit = null;

async function startLogin() {
  await mkdir(pluginDataDir, { recursive: true });
  await mkdir(authDir, { recursive: true });

  if (loginProcess && loginProcess.exitCode === null && !loginProcess.killed) {
    return { started: false, alreadyRunning: true, pid: loginProcess.pid };
  }

  await appendFile(loginLogPath, `\n[${new Date().toISOString()}] Starting Mercado Libre MCP OAuth login\n`, "utf8");

  loginProcess = spawn(
    "npx.cmd",
    ["-y", "-p", "mcp-remote@latest", "mcp-remote-client", config.mcpUrl],
    {
      windowsHide: true,
      detached: false,
      env: { ...process.env, MCP_REMOTE_CONFIG_DIR: authDir },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  const pipeLog = (stream, label) => {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk) => {
      void appendFile(loginLogPath, `[${label}] ${String(chunk)}`, "utf8").catch(() => undefined);
    });
  };
  pipeLog(loginProcess.stdout, "stdout");
  pipeLog(loginProcess.stderr, "stderr");

  loginProcess.on("exit", (code, signal) => {
    loginLastExit = { code, signal, at: new Date().toISOString() };
    void appendFile(
      loginLogPath,
      `\n[${new Date().toISOString()}] Login helper exited code=${code} signal=${signal || ""}\n`,
      "utf8"
    ).catch(() => undefined);
    loginProcess = null;
  });

  return {
    started: true,
    pid: loginProcess.pid,
    browser: "The OAuth helper will open Mercado Libre in the default browser on the HTPC.",
    note: "Authorize once. mcp-remote stores the OAuth session inside BWA 3D plugin-data for later reuse."
  };
}

class RemoteMcpBridge {
  constructor() {
    this.proc = null;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.readyPromise = null;
    this.lastError = null;
  }

  stop() {
    if (this.proc && this.proc.exitCode === null) {
      try { this.proc.kill(); } catch {}
    }
    this.proc = null;
    this.readyPromise = null;
    for (const pending of this.pending.values()) pending.reject(new Error("mercadolibre_mcp_stopped"));
    this.pending.clear();
  }

  async ensureReady() {
    if (this.readyPromise) return await this.readyPromise;
    this.readyPromise = this.startAndInitialize();
    try {
      return await this.readyPromise;
    } catch (error) {
      this.readyPromise = null;
      throw error;
    }
  }

  async startAndInitialize() {
    await mkdir(authDir, { recursive: true });
    const authFiles = await countFilesRecursive(authDir);
    if (authFiles === 0) throw new Error("mercadolibre_mcp_login_required");

    this.proc = spawn(
      "npx.cmd",
      ["-y", "mcp-remote@latest", config.mcpUrl],
      {
        windowsHide: true,
        env: { ...process.env, MCP_REMOTE_CONFIG_DIR: authDir },
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stdout.on("data", (chunk) => this.onStdout(String(chunk)));
    this.proc.stderr.on("data", (chunk) => {
      const text = String(chunk);
      this.lastError = text.slice(-1200);
      void appendFile(loginLogPath, `[bridge] ${text}`, "utf8").catch(() => undefined);
    });
    this.proc.on("exit", (code, signal) => {
      const err = new Error(`mercadolibre_mcp_exited code=${code} signal=${signal || ""}`);
      for (const pending of this.pending.values()) pending.reject(err);
      this.pending.clear();
      this.proc = null;
      this.readyPromise = null;
    });

    const initialized = await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "sol-bwa-3d", version: "0.1.0" }
    }, 20000);

    this.notify("notifications/initialized", {});
    return initialized;
  }

  onStdout(chunk) {
    this.buffer += chunk;
    for (;;) {
      const idx = this.buffer.indexOf("\n");
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && Object.prototype.hasOwnProperty.call(msg, "id")) {
        const pending = this.pending.get(msg.id);
        if (!pending) continue;
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error?.message || JSON.stringify(msg.error)));
        else pending.resolve(msg.result);
      }
    }
  }

  request(method, params = {}, timeoutMs = 15000) {
    if (!this.proc?.stdin?.writable) return Promise.reject(new Error("mercadolibre_mcp_not_running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mercadolibre_mcp_timeout:${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method, params = {}) {
    if (this.proc?.stdin?.writable) {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    }
  }

  async toolsList() {
    await this.ensureReady();
    return await this.request("tools/list", {}, 15000);
  }

  async callTool(name, args) {
    await this.ensureReady();
    return await this.request("tools/call", { name, arguments: args || {} }, 30000);
  }
}

const bridge = new RemoteMcpBridge();

function compactMcpResult(result) {
  if (!result || typeof result !== "object") return result;
  if (!Array.isArray(result.content)) return result;
  return {
    isError: Boolean(result.isError),
    content: result.content.map((item) => {
      if (item?.type === "text") {
        try {
          return { type: "json", value: JSON.parse(item.text) };
        } catch {
          return { type: "text", text: item.text };
        }
      }
      return item;
    })
  };
}

async function mcpStatus({ probe = false } = {}) {
  const authFiles = await countFilesRecursive(authDir);
  const result = {
    provider: "mercadolibre-devsite-mcp",
    url: config.mcpUrl,
    site: config.site,
    authenticatedMaterialPresent: authFiles > 0,
    authFileCount: authFiles,
    loginRunning: Boolean(loginProcess && loginProcess.exitCode === null && !loginProcess.killed),
    loginPid: loginProcess?.pid || null,
    loginLastExit,
    expectedTools: ["search_documentation", "get_documentation_page"]
  };
  if (probe && authFiles > 0) {
    try {
      const remote = await bridge.toolsList();
      result.connected = true;
      result.remoteTools = (remote?.tools || []).map((tool) => ({
        name: tool.name,
        description: tool.description || null
      }));
    } catch (error) {
      result.connected = false;
      result.error = error?.message || String(error);
    }
  }
  return result;
}

const tools = [
  {
    name: "bwa_3d_status",
    description: "Read BWA 3D plugin status, Mercado Libre MCP login state and readiness for the future private seller API.",
    inputSchema: { type: "object", properties: { probe: { type: "boolean", default: false } }, additionalProperties: false },
    requiredScope: "read"
  },
  {
    name: "bwa_3d_mercadolibre_mcp_status",
    description: "Read the official Mercado Libre DevSite MCP connection state. Pass probe=true to validate the remote MCP and list its live tools.",
    inputSchema: { type: "object", properties: { probe: { type: "boolean", default: false } }, additionalProperties: false },
    requiredScope: "read"
  },
  {
    name: "bwa_3d_mercadolibre_mcp_login",
    description: "Start the one-time OAuth login for Mercado Libre's official MCP on the HTPC. Opens the default browser and stores the resulting session in BWA 3D plugin-data. Requires explicit user confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        confirmedByUser: { type: "boolean", description: "Optional compatibility flag. SOL enforces confirmation for action tools." }
      },
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "bwa_3d_mercadolibre_mcp_logout",
    description: "Clear the Mercado Libre official MCP OAuth cache used by BWA 3D. Requires explicit user confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        confirmedByUser: { type: "boolean", description: "Optional compatibility flag. SOL enforces confirmation for action tools." }
      },
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "bwa_3d_mercadolibre_docs_search",
    description: "Search Mercado Libre's official developer documentation through the official Mercado Libre MCP server.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        language: { type: "string", default: "es_ar", maxLength: 20 },
        siteId: { type: "string", default: "MLA", maxLength: 20 },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        offset: { type: "integer", minimum: 0, maximum: 10000, default: 0 }
      },
      required: ["query"],
      additionalProperties: false
    },
    requiredScope: "read"
  },
  {
    name: "bwa_3d_mercadolibre_docs_page",
    description: "Retrieve one full Mercado Libre developer documentation page through the official Mercado Libre MCP server.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 1000 },
        language: { type: "string", default: "es_ar", maxLength: 20 },
        siteId: { type: "string", default: "MLA", maxLength: 20 }
      },
      required: ["path"],
      additionalProperties: false
    },
    requiredScope: "read"
  }
];

async function dispatchTool(tool, args) {
  if (tool === "bwa_3d_status") {
    return {
      ok: true,
      plugin: "bwa-3d",
      version: "0.1.0",
      modules: {
        mercadolibre: {
          mcp: await mcpStatus({ probe: Boolean(args.probe) }),
          sellerApi: {
            prepared: true,
            clientIdConfigured: Boolean(config.clientId),
            clientSecretConfigured: Boolean(config.clientSecret),
            redirectUriConfigured: Boolean(config.redirectUri),
            allowWrite: config.allowWrite,
            note: "The official DevSite MCP is documentation-only. Private seller operations will use Mercado Libre API OAuth with this plugin's own app credentials."
          }
        },
        correo: {
          prepared: false,
          note: "Reserved for the next BWA 3D module."
        }
      }
    };
  }

  if (tool === "bwa_3d_mercadolibre_mcp_status") {
    return await mcpStatus({ probe: Boolean(args.probe) });
  }

  if (tool === "bwa_3d_mercadolibre_mcp_login") {
    bridge.stop();
    return await startLogin();
  }

  if (tool === "bwa_3d_mercadolibre_mcp_logout") {
    bridge.stop();
    if (loginProcess && loginProcess.exitCode === null) {
      try { loginProcess.kill(); } catch {}
      loginProcess = null;
    }
    await rm(authDir, { recursive: true, force: true });
    return { ok: true, loggedOut: true };
  }

  if (tool === "bwa_3d_mercadolibre_docs_search") {
    const result = await bridge.callTool("search_documentation", {
      query: String(args.query || ""),
      language: String(args.language || "es_ar"),
      siteId: String(args.siteId || config.site),
      limit: Number(args.limit || 10),
      offset: Number(args.offset || 0)
    });
    return compactMcpResult(result);
  }

  if (tool === "bwa_3d_mercadolibre_docs_page") {
    const result = await bridge.callTool("get_documentation_page", {
      path: String(args.path || ""),
      language: String(args.language || "es_ar"),
      siteId: String(args.siteId || config.site)
    });
    return compactMcpResult(result);
  }

  throw new Error("tool_not_found");
}

let toolsRegistered = false;
let lastRegistrationError = null;

async function registerTools() {
  if (!sol.enabled) return;
  try {
    await sol.registerMcpTools(callbackUrl, tools);
    toolsRegistered = true;
    lastRegistrationError = null;
  } catch (error) {
    toolsRegistered = false;
    lastRegistrationError = error?.message || String(error);
    console.warn(`BWA 3D MCP tool registration failed: ${lastRegistrationError}`);
  }
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url || "/", "http://127.0.0.1").pathname;
  try {
    if (request.method === "GET" && path === "/health") {
      const status = await dispatchTool("bwa_3d_status", { probe: false });
      sendJson(response, 200, {
        ...status,
        solEnabled: sol.enabled,
        toolsRegistered,
        registrationError: lastRegistrationError
      });
      return;
    }

    if (request.method !== "POST" || path !== mcpPath) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    const body = await readJson(request);

    if (body?.type === "sol.plugin.mcp.probe") {
      if (body.pluginId !== pluginId) return sendJson(response, 403, { error: "plugin_id_mismatch" });
      return sendJson(response, 200, { ok: true, pluginId });
    }

    if (body?.type !== "sol.plugin.mcp.invoke" || body.pluginId !== pluginId) {
      return sendJson(response, 403, { error: "invalid_plugin_mcp_envelope" });
    }

    const result = await dispatchTool(
      String(body.tool || ""),
      body.arguments && typeof body.arguments === "object" ? body.arguments : {}
    );
    sendJson(response, 200, result);
  } catch (error) {
    const message = error?.message || String(error);
    const status = message.includes("login_required") ? 401
      : message.includes("required") || message.includes("invalid") ? 400
      : 502;
    sendJson(response, status, { error: message });
  }
});

server.listen(config.apiPort, "127.0.0.1", async () => {
  await mkdir(pluginDataDir, { recursive: true }).catch(() => undefined);
  console.log(JSON.stringify({
    type: "sol.plugin.ready",
    health: "healthy",
    details: {
      provider: "bwa-3d",
      port: config.apiPort,
      mercadoLibreMcp: config.mcpUrl,
      mercadoLibreSite: config.site
    }
  }));
  await registerTools();
});

const retry = setInterval(() => {
  if (!toolsRegistered) void registerTools();
}, 15000);
retry.unref?.();

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(retry);
  bridge.stop();
  if (loginProcess && loginProcess.exitCode === null) {
    try { loginProcess.kill(); } catch {}
  }
  if (sol.enabled) await sol.registerMcpTools(callbackUrl, []).catch(() => undefined);
  server.close();
  console.log(`${signal}: stopping BWA 3D SOL plugin`);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
