import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { parseSources, observe } from "./core.mjs";
import { inferLocally } from "./model.mjs";

const pluginId = process.env.SOL_PLUGIN_ID?.trim() || "sol-agent";
const dataDir = process.env.SOL_PLUGIN_DATA_DIR?.trim() || join(process.env.SOL_PLUGIN_ROOT?.trim() || process.cwd(), ".data");
const storePath = join(dataDir, "sol-agent-shadow.json");
const port = Number(process.env.SOL_AGENT_PORT || 8796);
const rawInterval = Number(process.env.SOL_AGENT_INTERVAL_MINUTES || 15);
const intervalMs = Number.isFinite(rawInterval) ? Math.max(300000, Math.min(86400000, rawInterval * 60000)) : 900000;
const sources = parseSources(process.env.SOL_AGENT_SOURCES_JSON || "[]");
const objectives = (process.env.SOL_AGENT_OBJECTIVES || "Detectar oportunidades y riesgos, investigar y proponer sin ejecutar.").slice(0, 800);
const modelConfigured = process.env.SOL_AGENT_MODEL_ENABLED === "true" && Boolean(process.env.SOL_AGENT_MODEL_NAME?.trim());
const modelName = process.env.SOL_AGENT_MODEL_NAME?.trim() || "";
const modelEndpoint = process.env.SOL_AGENT_MODEL_ENDPOINT?.trim() || "http://127.0.0.1:11434/v1/chat/completions";
const modelToken = process.env.SOL_AGENT_MODEL_TOKEN || "";
const apiUrl = (process.env.SOL_PLUGIN_API_URL || process.env.SOL_CORE_URL || "").trim().replace(/\/$/, "");
const apiToken = process.env.SOL_PLUGIN_TOKEN || "";
const coreReady = Boolean(apiUrl && apiToken);
const secretPath = "/mcp/" + randomBytes(24).toString("base64url");
const callbackUrl = "http://127.0.0.1:" + port + secretPath;
let state = { version: 1, snapshots: {}, proposals: [], budget: {} };
let busy = false, lastError = null, lastRun = null, toolsRegistered = false, server;

function status() {
  const utcDay = new Date().toISOString().slice(0, 10);
  return { ok: true, plugin: pluginId, version: "0.1.0", mode: "shadow",
    canExecute: false, canNotify: false, sources: sources.length,
    modelConfigured, coreReady, toolsRegistered, busy, lastRun, lastError,
    proposals: state.proposals?.length || 0, modelCallsToday: state.budget?.[utcDay] || 0,
    modelDailyLimit: 8 };
}
async function load() {
  try {
    const data = JSON.parse(await readFile(storePath, "utf8"));
    if (!data || data.version !== 1 || !Array.isArray(data.proposals) || !data.snapshots || typeof data.snapshots !== "object") throw new Error("invalid_agent_store");
    state = data;
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
}
async function save() {
  await mkdir(dataDir, { recursive: true });
  const tmp = storePath + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, storePath);
}
async function solRequest(path, body) {
  if (!coreReady) throw new Error("sol_plugin_api_unavailable");
  const reply = await fetch(apiUrl + path, {
    method: "POST",
    headers: { authorization: "Bearer " + apiToken, "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
  });
  const text = await reply.text();
  if (text.length > 200000) throw new Error("sol_response_too_large");
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("sol_invalid_response"); }
  if (!reply.ok) throw new Error("sol_http_" + reply.status + ": " + String(data?.error || "").slice(0, 80));
  return data;
}
async function invokeRead(name, args) {
  // Never use the generic MCP invoke or any write/action endpoint.
  return solRequest("/v1/plugin-api/mcp/tools/invoke-read", { name, arguments: args });
}
export async function tick() {
  if (busy) return { skipped: "busy" };
  if (!coreReady || !sources.length) return { skipped: "no_api_or_sources" };
  busy = true; lastRun = new Date().toISOString();
  const day = lastRun.slice(0, 10);
  const today = state.budget?.[day] || 0;
  let attempted = false;
  try {
    const infer = modelConfigured && today < 8
      ? async ({ changes, history }) => {
          attempted = true;
          return inferLocally({ endpoint: modelEndpoint, model: modelName, token: modelToken,
            objectives, changes: changes.map(({ hash, ...safe }) => safe), history });
        } : null;
    const outcome = await observe({ state: { ...state, objectives }, sources, invokeRead, infer });
    state = { ...outcome.state, objectives: undefined };
    state.budget = { [day]: today + Number(attempted) };
    await save();
    lastError = null;
    return { ...outcome, state: undefined };
  } catch (error) {
    if (attempted) { state.budget = { [day]: today + 1 }; await save().catch(() => {}); }
    lastError = String(error?.message || error).slice(0, 140);
    return { ok: false, error: lastError };
  } finally { busy = false; }
}
const mcpTools = [
  { name: "sol_agent_status", description: "Read-only SOL Agent shadow health and counters.", requiredScope: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "sol_agent_proposals", description: "Read-only list of suggestions. Does not approve or perform actions.", requiredScope: "read",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false } }
];
async function register(tools = mcpTools) {
  if (!coreReady) return;
  try {
    const result = await solRequest("/v1/plugin-api/mcp/tools/register", { callbackUrl, tools });
    toolsRegistered = tools.length > 0 && result?.tools?.length === tools.length;
  } catch (error) { toolsRegistered = false; lastError = String(error?.message || error).slice(0, 140); }
}
function sendJson(res, code, value) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
async function parseBody(req) {
  let input = "";
  for await (const chunk of req) {
    input += chunk;
    if (input.length > 16384) throw new Error("request_too_large");
  }
  return JSON.parse(input || "{}");
}
export async function start() {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("invalid_port");
  await mkdir(dataDir, { recursive: true });
  await load();
  server = createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
    if (req.method === "GET" && path === "/health") return sendJson(res, 200, status());
    if (req.method !== "POST" || path !== secretPath) return sendJson(res, 404, { error: "not_found" });
    try {
      const body = await parseBody(req);
      if (body.pluginId !== pluginId) return sendJson(res, 403, { error: "plugin_mismatch" });
      if (body.type === "sol.plugin.mcp.probe") return sendJson(res, 200, { ok: true, pluginId });
      if (body.type !== "sol.plugin.mcp.invoke") return sendJson(res, 403, { error: "invalid_envelope" });
      if (body.tool === "sol_agent_status") return sendJson(res, 200, status());
      if (body.tool === "sol_agent_proposals") {
        const limit = Math.min(50, Math.max(1, Number(body.arguments?.limit) || 20));
        return sendJson(res, 200, { ok: true, proposals: (state.proposals || []).slice(-limit).reverse() });
      }
      return sendJson(res, 404, { error: "unknown_tool" });
    } catch { return sendJson(res, 400, { error: "bad_request" }); }
  });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  console.log(JSON.stringify({ type: "sol.plugin.ready", health: "healthy", details: { provider: pluginId, mode: "shadow", port } }));
  await register();
  const interval = setInterval(() => { void tick(); }, intervalMs);
  interval.unref?.();
  const retry = setInterval(() => { if (!toolsRegistered) void register(); }, 30000);
  retry.unref?.();
  void tick();
  for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, async () => {
    clearInterval(interval); clearInterval(retry);
    await register([]).catch(() => {});
    server.close();
    process.exit(0);
  });
}
