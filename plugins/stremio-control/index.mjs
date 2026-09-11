import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { StremioControlClient } from "./lib/stremio-client.mjs";
import { SolPluginClient } from "./lib/sol-client.mjs";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function numberEnv(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value))) : fallback;
}

function sendJson(response, status, value) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 256 * 1024) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("json_object_required");
  return value;
}

const config = {
  baseUrl: required("STREMIO_SOL_URL"),
  token: process.env.STREMIO_SOL_TOKEN?.trim() || "",
  allowControl: boolEnv("STREMIO_SOL_ALLOW_CONTROL", false),
  timeoutMs: numberEnv("STREMIO_SOL_TIMEOUT_MS", 8000, 1000, 30000),
  pluginPort: numberEnv("STREMIO_SOL_PLUGIN_PORT", 8770, 1024, 65535),
  dataDir: process.env.SOL_PLUGIN_DATA_DIR || new URL("./.data", import.meta.url).pathname
};

await mkdir(config.dataDir, { recursive: true });
const stremio = new StremioControlClient({
  baseUrl: config.baseUrl,
  token: config.token,
  timeoutMs: config.timeoutMs,
  dataDir: config.dataDir
});
await stremio.initialize();
const sol = new SolPluginClient();
const pluginId = process.env.SOL_PLUGIN_ID?.trim() || "stremio-control";
const mcpPath = `/mcp/${randomBytes(24).toString("base64url")}`;
const callbackUrl = `http://127.0.0.1:${config.pluginPort}${mcpPath}`;

const tools = [
  {
    name: "stremio_status",
    description: "Read the SOL-enabled Stremio Android endpoint status and pairing state. Use before control if connectivity is uncertain.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredScope: "read"
  },
  {
    name: "stremio_player_state",
    description: "Read current Stremio playback state, position, duration, buffering state, audio tracks and subtitle tracks.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredScope: "read"
  },
  {
    name: "stremio_search",
    description: "Search the user's installed Stremio catalogs semantically. Returns real Stremio type/id pairs suitable for stremio_play.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200 },
        limit: { type: "integer", minimum: 1, maximum: 40, default: 12 }
      },
      required: ["query"],
      additionalProperties: false
    },
    requiredScope: "read"
  },
  {
    name: "stremio_pair",
    description: "Pair SOL with the Stremio Android control API using the six-digit code visibly shown by Stremio. Only use after the human explicitly asks to pair this TV.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", pattern: "^[0-9]{6}$" },
        confirmedByUser: { type: "boolean", description: "Must be true only after explicit human confirmation." }
      },
      required: ["code", "confirmedByUser"],
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "stremio_play",
    description: "Resolve and play a real Stremio catalog item by type/id. For series, provide videoId when known; otherwise the API may choose the appropriate/default video. streamIndex optionally selects a returned stream candidate.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", minLength: 1, maxLength: 40 },
        id: { type: "string", minLength: 1, maxLength: 240 },
        videoId: { type: "string", minLength: 1, maxLength: 240 },
        streamIndex: { type: "integer", minimum: 0, maximum: 99, default: 0 },
        engine: { type: "string", enum: ["exo", "mpv"], default: "exo" }
      },
      required: ["type", "id"],
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "stremio_pause",
    description: "Pause the active Stremio player.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredScope: "actions"
  },
  {
    name: "stremio_resume",
    description: "Resume the active Stremio player.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredScope: "actions"
  },
  {
    name: "stremio_seek",
    description: "Seek Stremio playback. Use exactly one of positionMs (absolute) or offsetMs (relative, may be negative).",
    inputSchema: {
      type: "object",
      properties: {
        positionMs: { type: "integer", minimum: 0 },
        offsetMs: { type: "integer", minimum: -86400000, maximum: 86400000 }
      },
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "stremio_select_audio",
    description: "Select an audio track by the id returned by stremio_player_state.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1, maxLength: 500 } },
      required: ["id"],
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "stremio_select_subtitle",
    description: "Select a subtitle track by the id returned by stremio_player_state.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1, maxLength: 500 } },
      required: ["id"],
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "stremio_disable_subtitles",
    description: "Disable subtitles in the active Stremio player.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredScope: "actions"
  }
];

function requireControl() {
  if (!config.allowControl) throw new Error("stremio_control_disabled");
  if (!stremio.paired) throw new Error("stremio_not_paired");
}

async function invoke(tool, args) {
  if (tool === "stremio_status") {
    const health = await stremio.health();
    return { ...health, solPaired: stremio.paired, controlEnabled: config.allowControl, endpoint: config.baseUrl };
  }
  if (tool === "stremio_pair") {
    if (args.confirmedByUser !== true) throw new Error("explicit_user_confirmation_required");
    return await stremio.pair(args.code, "SOL");
  }
  if (tool === "stremio_player_state") return await stremio.playerState();
  if (tool === "stremio_search") {
    const query = String(args.query || "").trim();
    if (!query) throw new Error("stremio_search_query_required");
    return await stremio.search(query, Math.max(1, Math.min(40, Number(args.limit || 12))));
  }

  requireControl();
  if (tool === "stremio_play") {
    const type = String(args.type || "").trim();
    const id = String(args.id || "").trim();
    if (!type || !id) throw new Error("stremio_type_and_id_required");
    return await stremio.play({
      type,
      id,
      ...(args.videoId ? { videoId: String(args.videoId) } : {}),
      streamIndex: Number(args.streamIndex || 0),
      engine: args.engine === "mpv" ? "mpv" : "exo"
    });
  }
  if (tool === "stremio_pause") return await stremio.pause();
  if (tool === "stremio_resume") return await stremio.resume();
  if (tool === "stremio_seek") {
    const hasPosition = Number.isFinite(Number(args.positionMs));
    const hasOffset = Number.isFinite(Number(args.offsetMs));
    if (hasPosition === hasOffset) throw new Error("provide_exactly_one_of_positionMs_or_offsetMs");
    return await stremio.seek(hasPosition ? { positionMs: Number(args.positionMs) } : { offsetMs: Number(args.offsetMs) });
  }
  if (tool === "stremio_select_audio") return await stremio.selectAudio(String(args.id || ""));
  if (tool === "stremio_select_subtitle") return await stremio.selectSubtitle(String(args.id || ""));
  if (tool === "stremio_disable_subtitles") return await stremio.disableSubtitles();
  throw new Error("tool_not_found");
}

let toolsRegistered = false;
async function registerTools() {
  if (!sol.enabled) return;
  try {
    await sol.registerMcpTools(callbackUrl, tools);
    toolsRegistered = true;
  } catch (error) {
    toolsRegistered = false;
    console.warn(`SOL Stremio tool registration failed: ${error?.message || error}`);
  }
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url || "/", "http://127.0.0.1").pathname;
  try {
    if (request.method === "GET" && path === "/health") {
      let remote = null;
      try { remote = await stremio.health(); } catch (error) { remote = { ok: false, error: error?.message || String(error) }; }
      sendJson(response, 200, { ok: true, pluginId, remote, paired: stremio.paired, controlEnabled: config.allowControl });
      return;
    }
    if (request.method !== "POST" || path !== mcpPath) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    const body = await readJson(request);
    if (body?.type === "sol.plugin.mcp.probe") {
      if (body.pluginId !== pluginId) return sendJson(response, 403, { error: "plugin_id_mismatch" });
      sendJson(response, 200, { ok: true, pluginId });
      return;
    }
    if (body?.type !== "sol.plugin.mcp.invoke" || body.pluginId !== pluginId) {
      sendJson(response, 403, { error: "invalid_plugin_mcp_envelope" });
      return;
    }
    const result = await invoke(String(body.tool || ""), body.arguments && typeof body.arguments === "object" ? body.arguments : {});
    sendJson(response, 200, result);
  } catch (error) {
    const message = error?.message || String(error);
    const status = message.includes("confirmation") || message.includes("disabled") || message.includes("not_paired") ? 403
      : message.includes("required") || message.includes("provide_exactly") ? 400
        : message.includes("not_found") ? 404
          : 502;
    sendJson(response, status, { error: message });
  }
});

server.listen(config.pluginPort, "127.0.0.1", async () => {
  console.log(`Stremio Control SOL plugin listening on loopback port ${config.pluginPort}`);
  await registerTools();
  console.log(JSON.stringify({ type: "sol.plugin.ready", health: "healthy", details: { provider: "stremio_control", paired: stremio.paired } }));
});

const registrationRetryTimer = setInterval(() => {
  if (!toolsRegistered) void registerTools();
}, 15000);
registrationRetryTimer.unref?.();

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(registrationRetryTimer);
  console.log(`${signal}: stopping Stremio Control SOL plugin`);
  if (sol.enabled) await sol.registerMcpTools(callbackUrl, []).catch(() => undefined);
  server.close();
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
