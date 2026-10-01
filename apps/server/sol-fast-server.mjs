import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createServer } from "node:http";

const HOST = "127.0.0.1";
const PORT = Number(process.env.SOL_FAST_PORT || 8770);

const mcpEnv = {
  ...process.env,
  SOL_DATA_DIR: process.env.SOL_DATA_DIR || "C:/Users/diego/AppData/Local/SOL",
  SOL_ENV_FILE: process.env.SOL_ENV_FILE || "C:/Users/diego/AppData/Local/SOL/.env",
  SOL_MCP_TOKEN_FILE: process.env.SOL_MCP_TOKEN_FILE || "C:/Users/diego/AppData/Local/SOL/secrets/chatgpt-sol-mcp-token.txt",
};

let client = null;
let transport = null;
let coreTools = [];
let connecting = null;

let nexoClient = null;
let nexoTransport = null;
let nexoTools = [];
let nexoConnecting = null;

let tools = [];
const toolProviders = new Map();

function rebuildCatalog() {
  tools = [];
  toolProviders.clear();

  for (const tool of coreTools) {
    tools.push(tool);
    toolProviders.set(tool.name, "core");
  }
  for (const tool of nexoTools) {
    if (toolProviders.has(tool.name)) continue;
    tools.push(tool);
    toolProviders.set(tool.name, "nexo");
  }
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
    total += chunk.length;
    if (total > 1024 * 1024) throw new Error("request_too_large");
    chunks.push(Buffer.from(chunk));
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function connectMcp() {
  if (client) return client;
  if (connecting) return connecting;

  connecting = (async () => {
    const nextClient = new Client({ name: "sol-fast-local", version: "1.0.0" });
    const nextTransport = new StdioClientTransport({
      command: "C:/SOL/SOL/runtime/node.exe",
      args: [
        "--import",
        "file:///C:/SOL/SOL/apps/server/dist/mcp/stdio-preload.mjs",
        "C:/SOL/SOL/apps/server/dist/mcp/nexo-stdio.js",
      ],
      env: mcpEnv,
    });
    await nextClient.connect(nextTransport);
    const listed = await nextClient.listTools();
    coreTools = listed.tools || [];
    client = nextClient;
    transport = nextTransport;
    connecting = null;
    rebuildCatalog();
    return client;
  })().catch((error) => {
    connecting = null;
    client = null;
    transport = null;
    coreTools = [];
    rebuildCatalog();
    throw error;
  });

  return connecting;
}

async function connectNexoMcp() {
  if (nexoClient) return nexoClient;
  if (nexoConnecting) return nexoConnecting;

  nexoConnecting = (async () => {
    const nextClient = new Client({ name: "sol-fast-nexo", version: "1.0.0" });
    const nextTransport = new StdioClientTransport({
      command: "C:/SOL/SOL/runtime/node.exe",
      args: ["C:/Users/diego/AppData/Local/SOL/plugins/nexo-whatsapp/dist/mcp.js"],
      env: { ...process.env },
    });
    await nextClient.connect(nextTransport);
    const listed = await nextClient.listTools();
    nexoTools = listed.tools || [];
    nexoClient = nextClient;
    nexoTransport = nextTransport;
    nexoConnecting = null;
    rebuildCatalog();
    return nexoClient;
  })().catch((error) => {
    nexoConnecting = null;
    nexoClient = null;
    nexoTransport = null;
    nexoTools = [];
    rebuildCatalog();
    throw error;
  });

  return nexoConnecting;
}

async function connectAll() {
  await Promise.all([connectMcp(), connectNexoMcp()]);
}

async function callTool(name, args = {}) {
  await connectAll();
  const provider = toolProviders.get(name);
  if (!provider) throw new Error("tool_not_found");

  const active = provider === "nexo" ? nexoClient : client;
  try {
    return await active.callTool({ name, arguments: args });
  } catch (error) {
    if (provider === "nexo") {
      nexoClient = null;
      nexoTransport = null;
      nexoTools = [];
    } else {
      client = null;
      transport = null;
      coreTools = [];
    }
    rebuildCatalog();
    throw error;
  }
}

function unwrapResult(value) {
  const content = value?.content;
  if (Array.isArray(content) && content.length === 1 && content[0]?.type === "text") {
    const raw = content[0].text;
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return value;
}

function normalizeYoutubeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("youtube_url_required");

  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error("youtube_url_invalid"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("youtube_url_invalid_protocol");

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const allowed = host === "youtu.be"
    || host === "youtube.com"
    || host === "m.youtube.com"
    || host === "music.youtube.com";
  if (!allowed) throw new Error("youtube_url_invalid_host");

  return parsed.toString();
}

const quickMap = {
  tv_cocina: () => ["home_assistant_get_state", { entityId: "media_player.tv_cocina_2" }],
  aire_cocina: () => ["home_assistant_get_state", { entityId: "climate.aire_cocina" }],
  home_find: (a) => ["home_assistant_search_states", { query: String(a.query || ""), limit: Number(a.limit || 20) }],
  media_play: (a) => ["home_assistant_stremio_play_best", a],
  youtube_play: (a) => ["home_assistant_call_service", {
    domain: "media_player",
    service: "play_media",
    target: { entity_id: String(a.entityId || "media_player.tv_cocina_2") },
    serviceData: {
      media: {
        media_content_id: normalizeYoutubeUrl(a.url),
        media_content_type: "url"
      }
    },
    confirmedByUser: true
  }],
  whatsapp_search: (a) => ["search_whatsapp", { query: String(a.query || ""), limit: Number(a.limit || 20) }],
  memory_search: (a) => ["memory_search", { query: String(a.query || ""), limit: Number(a.limit || 20) }],
  context_search: (a) => ["search_life", { query: String(a.query || ""), limit: Number(a.limit || 20) }],
  home_action: (a) => ["home_assistant_call_service", { ...a, confirmedByUser: true }],
};

const quickDocs = {
  tv_cocina: {
    kind: "read",
    usage: "sol-fast.ps1 tv_cocina",
    description: "Read the current kitchen TV state."
  },
  aire_cocina: {
    kind: "read",
    usage: "sol-fast.ps1 aire_cocina",
    description: "Read the current kitchen air-conditioner state."
  },
  home_find: {
    kind: "read",
    usage: "sol-fast.ps1 home_find \"search text\"",
    description: "Search live Home Assistant entities and states."
  },
  media_play: {
    kind: "action",
    usage: "sol-fast.ps1 media_play \"title or media query\" ['{\"language\":\"spanish|latin|english\",\"quality\":\"auto|4k|1080p|720p|480p\"}']",
    description: "Use SOL's deterministic Stremio playback flow. Default language is unrestricted (any): do not send a language field unless the user explicitly asks for Spanish, Latin Spanish, or English."
  },
  youtube_play: {
    kind: "action",
    usage: "sol-fast.ps1 youtube_play \"https://www.youtube.com/watch?v=...\"",
    description: "Play a YouTube URL on TV Cocina through Home Assistant media_player.play_media using an Android TV deep link. If the user names a video/song instead of giving a URL, resolve a concrete YouTube URL first, then use this command. Prefer this over raw home_action."
  },
  whatsapp_search: {
    kind: "read",
    usage: "sol-fast.ps1 whatsapp_search \"search text\"",
    description: "Search WhatsApp context observed by Nexo/SOL."
  },
  memory_search: {
    kind: "read",
    usage: "sol-fast.ps1 memory_search \"search text\"",
    description: "Search durable SOL memory."
  },
  context_search: {
    kind: "read",
    usage: "sol-fast.ps1 context_search \"search text\"",
    description: "Search broader SOL Life context."
  },
  home_action: {
    kind: "action",
    usage: "sol-fast.ps1 home_action '{\"domain\":\"media_player\",\"service\":\"turn_off\",\"target\":{\"entity_id\":\"media_player.example\"},\"serviceData\":{}}'",
    description: "Execute a Home Assistant service. The current user request must explicitly authorize the action. SOL Fast adds confirmedByUser=true."
  }
};

function helpPayload(extra = {}) {
  return {
    service: "SOL Fast",
    version: "1.2",
    purpose: "Fast local aggregate bridge to the user's authenticated SOL Full and Nexo MCPs.",
    modelInstructions: [
      "Do not pass the user's natural-language sentence as the command name.",
      "Translate the request to a documented quick command or inspect the real SOL Full tool catalog.",
      "For an unfamiliar capability, run: sol-fast.ps1 tools",
      "For YouTube playback on TV Cocina, resolve a concrete YouTube URL if needed, then prefer: sol-fast.ps1 youtube_play <url>.",
      "For Stremio playback, leave language unspecified by default. Only set language=spanish, latin, or english when the user explicitly requests that language.",
      "Before calling an unfamiliar raw tool, run: sol-fast.ps1 schema <tool_name>",
      "Use actions only when the current user request explicitly authorizes them.",
      "After a real-world action, read the relevant state again before claiming success."
    ],
    quickCommands: quickDocs,
    discovery: {
      help: "sol-fast.ps1 help",
      tools: "sol-fast.ps1 tools",
      schema: "sol-fast.ps1 schema <tool_name>",
      rawCall: "sol-fast.ps1 call <tool_name> '<json arguments>'"
    },
    toolCount: tools.length,
    ...extra
  };
}

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${HOST}`);
  const path = requestUrl.pathname;
  try {
    if (req.method === "GET" && path === "/health") {
      await connectAll();
      return sendJson(res, 200, {
        ok: true,
        service: "sol-fast",
        version: "1.2",
        connected: Boolean(client) && Boolean(nexoClient),
        providers: {
          core: { connected: Boolean(client), toolCount: coreTools.length },
          nexo: { connected: Boolean(nexoClient), toolCount: nexoTools.length }
        },
        toolCount: tools.length
      });
    }
    if (req.method === "GET" && path === "/help") {
      await connectAll();
      return sendJson(res, 200, helpPayload());
    }
    if (req.method === "GET" && path === "/tools") {
      await connectAll();
      return sendJson(res, 200, {
        service: "SOL Fast",
        instruction: "Choose a quick command when one matches the request; otherwise choose a raw tool and run schema before an unfamiliar call.",
        quickCommands: quickDocs,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description || "",
          inputSchema: t.inputSchema || { type: "object", properties: {} },
          annotations: t.annotations || null,
          provider: toolProviders.get(t.name) || "unknown"
        }))
      });
    }
    if (req.method === "GET" && path === "/schema") {
      await connectAll();
      const name = String(requestUrl.searchParams.get("tool") || "");
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        return sendJson(res, 200, helpPayload({
          error: "tool_not_found",
          requestedTool: name,
          nextStep: "Run sol-fast.ps1 tools, choose an exact tool name, then retry schema."
        }));
      }
      return sendJson(res, 200, {
        name: tool.name,
        description: tool.description || "",
        inputSchema: tool.inputSchema || { type: "object", properties: {} },
        annotations: tool.annotations || null,
        provider: toolProviders.get(tool.name) || "unknown",
        nextStep: `Use: sol-fast.ps1 call ${tool.name} '<json arguments matching inputSchema>'`
      });
    }
    if (req.method === "POST" && path === "/call") {
      const body = await readJson(req);
      const name = String(body.tool || "");
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        return sendJson(res, 200, helpPayload({
          error: "tool_not_found",
          requestedTool: name,
          nextStep: "Run sol-fast.ps1 tools, choose an exact tool name, then inspect it with schema."
        }));
      }
      const args = body.arguments && typeof body.arguments === "object" ? body.arguments : {};
      const result = await callTool(name, args);
      return sendJson(res, 200, { tool: name, result: unwrapResult(result) });
    }
    if (req.method === "POST" && path === "/quick") {
      const body = await readJson(req);
      const command = String(body.command || "");
      const maker = quickMap[command];
      if (!maker) {
        return sendJson(res, 200, helpPayload({
          error: "unknown_quick_command",
          receivedCommand: command,
          nextStep: "Do not send natural language as the command. Choose a documented quick command, or use tools/schema/call for SOL Full."
        }));
      }
      if (["home_action", "youtube_play"].includes(command) && body.confirmedByUser !== true) {
        return sendJson(res, 403, { error: "user_confirmation_required" });
      }
      const args = body.arguments && typeof body.arguments === "object" ? body.arguments : {};
      let tool;
      let toolArgs;
      try {
        [tool, toolArgs] = maker(args);
      } catch (error) {
        return sendJson(res, 200, helpPayload({
          error: error?.message || String(error),
          receivedCommand: command,
          nextStep: command === "youtube_play"
            ? "Resolve a valid youtube.com or youtu.be URL and retry youtube_play."
            : "Correct the quick-command arguments and retry."
        }));
      }
      const result = await callTool(tool, toolArgs);
      return sendJson(res, 200, { command, tool, result: unwrapResult(result) });
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error?.message || String(error) });
  }
});
await connectAll();

server.listen(PORT, HOST, () => {
  console.log(`SOL fast bridge listening on http://${HOST}:${PORT} with ${tools.length} tools`);
});

async function shutdown() {
  try { await client?.close(); } catch {}
  try { await transport?.close(); } catch {}
  try { await nexoClient?.close(); } catch {}
  try { await nexoTransport?.close(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
