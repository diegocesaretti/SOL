import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

const NAVIGATION_COMMANDS = {
  home: "HOME",
  back: "BACK",
  up: "DPAD_UP",
  down: "DPAD_DOWN",
  left: "DPAD_LEFT",
  right: "DPAD_RIGHT",
  center: "DPAD_CENTER"
};

export const HA_ONLY_TV_TOOLS = [
  {
    name: "home_assistant_tv_status",
    description: "Report Android TV control status in Home Assistant-only mode. No Android TV Satellite requests are made.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredScope: "read"
  },
  {
    name: "home_assistant_tv_navigate",
    description: "Send Home, Back or DPAD keys directly through the configured Home Assistant remote. No Satellite, screenshot or Accessibility request is used.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["home", "back", "up", "down", "left", "right", "center"] },
        count: { type: "integer", minimum: 1, maximum: 12, default: 1 }
      },
      required: ["direction"],
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "home_assistant_tv_navigate_path",
    description: "Send a deterministic sequence of Home/Back/DPAD keys directly through Home Assistant remote.send_command. No Satellite is contacted.",
    inputSchema: {
      type: "object",
      properties: {
        moves: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: {
            type: "object",
            properties: {
              direction: { type: "string", enum: ["home", "back", "up", "down", "left", "right", "center"] },
              count: { type: "integer", minimum: 1, maximum: 12, default: 1 }
            },
            required: ["direction"],
            additionalProperties: false
          }
        }
      },
      required: ["moves"],
      additionalProperties: false
    },
    requiredScope: "actions"
  }
];

async function readRequestBody(request, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function normalizedCount(direction, count) {
  if (["home", "back", "center"].includes(direction)) return 1;
  const value = Number(count ?? 1);
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(12, Math.trunc(value)));
}

function remoteEntityId(client) {
  return String(client?.stremioRemoteEntityId || client?.env?.HA_SOL_TV_REMOTE_ENTITY_ID || "").trim();
}

async function sendCommands(client, commands) {
  const entityId = remoteEntityId(client);
  if (!entityId) throw new Error("tv_remote_entity_id_required");
  if (!Array.isArray(commands) || !commands.length) throw new Error("tv_remote_commands_required");
  const result = await client.haService("remote", "send_command", {
    entity_id: entityId,
    command: commands
  });
  return {
    ok: true,
    mode: "home_assistant_only",
    via: "home_assistant_remote",
    satelliteUsed: false,
    entityId,
    commands,
    result
  };
}

async function handleTvTool(client, tool, args = {}) {
  if (tool === "home_assistant_tv_status") {
    const entityId = remoteEntityId(client);
    return {
      mode: "home_assistant_only",
      satelliteUsed: false,
      remoteConfigured: Boolean(entityId),
      remoteEntityId: entityId || null,
      transport: "Home Assistant remote.send_command",
      visualObservationAvailable: false
    };
  }

  if (tool === "home_assistant_tv_navigate") {
    const direction = String(args.direction || "").trim().toLowerCase();
    const command = NAVIGATION_COMMANDS[direction];
    if (!command) throw new Error("tv_navigation_direction_invalid");
    const count = normalizedCount(direction, args.count);
    return sendCommands(client, Array.from({ length: count }, () => command));
  }

  if (tool === "home_assistant_tv_navigate_path") {
    if (!Array.isArray(args.moves) || args.moves.length < 1 || args.moves.length > 10) {
      throw new Error("tv_navigation_path_requires_1_to_10_moves");
    }
    const commands = [];
    const path = [];
    for (const move of args.moves) {
      const direction = String(move?.direction || "").trim().toLowerCase();
      const command = NAVIGATION_COMMANDS[direction];
      if (!command) throw new Error("tv_navigation_direction_invalid");
      const count = normalizedCount(direction, move?.count);
      path.push({ direction, count });
      for (let index = 0; index < count; index += 1) commands.push(command);
      if (commands.length > 40) throw new Error("tv_navigation_path_too_long");
    }
    return { ...(await sendCommands(client, commands)), path, totalKeypresses: commands.length };
  }

  throw new Error("tv_tool_not_found");
}

async function ensureProxy(client, targetUrl) {
  if (client.__haOnlyTvProxyServer && client.__haOnlyTvProxyUrl && client.__haOnlyTvProxyTarget === targetUrl) {
    return client.__haOnlyTvProxyUrl;
  }
  if (client.__haOnlyTvProxyServer) {
    await new Promise((resolve) => client.__haOnlyTvProxyServer.close(() => resolve()));
  }

  const path = `/ha-tv/${randomBytes(20).toString("base64url")}`;
  client.__haOnlyTvProxyTarget = targetUrl;
  client.__haOnlyTvProxyServer = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method !== "POST" || url.pathname !== path) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }

      const raw = await readRequestBody(request);
      let body;
      try { body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; }
      catch { sendJson(response, 400, { error: "invalid_json" }); return; }

      const tool = String(body?.tool || "");
      if (body?.type === "sol.plugin.mcp.invoke" && tool.startsWith("home_assistant_tv_")) {
        try {
          const result = await handleTvTool(client, tool, body?.arguments && typeof body.arguments === "object" ? body.arguments : {});
          sendJson(response, 200, result);
        } catch (error) {
          const message = error?.message || String(error);
          const status = message.includes("required") || message.includes("invalid") || message.includes("too_long") ? 400 : 500;
          sendJson(response, status, { error: message });
        }
        return;
      }

      const forwarded = await fetch(client.__haOnlyTvProxyTarget, {
        method: "POST",
        headers: { "content-type": request.headers["content-type"] || "application/json" },
        body: raw,
        signal: AbortSignal.timeout(30000)
      });
      response.statusCode = forwarded.status;
      response.setHeader("content-type", forwarded.headers.get("content-type") || "application/json; charset=utf-8");
      response.end(Buffer.from(await forwarded.arrayBuffer()));
    } catch (error) {
      sendJson(response, 500, { error: error?.message || String(error) });
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    client.__haOnlyTvProxyServer.once("error", onError);
    client.__haOnlyTvProxyServer.listen(0, "127.0.0.1", () => {
      client.__haOnlyTvProxyServer.off("error", onError);
      resolve();
    });
  });
  client.__haOnlyTvProxyServer.unref?.();
  const address = client.__haOnlyTvProxyServer.address();
  if (!address || typeof address === "string") throw new Error("ha_only_tv_proxy_start_failed");
  client.__haOnlyTvProxyUrl = `http://127.0.0.1:${address.port}${path}`;
  return client.__haOnlyTvProxyUrl;
}

export function installHomeAssistantOnlyTvControl(SolPluginClient) {
  const proto = SolPluginClient?.prototype;
  if (!proto || proto.__haOnlyTvInstalled) return SolPluginClient;
  proto.__haOnlyTvInstalled = true;

  const originalRegister = proto.registerMcpTools;
  proto.registerMcpTools = async function registerMcpToolsWithHaTv(callbackUrl, tools) {
    const requested = Array.isArray(tools) ? tools : [];
    const names = new Set(requested.map((tool) => tool?.name).filter(Boolean));
    const extended = [...requested, ...HA_ONLY_TV_TOOLS.filter((tool) => !names.has(tool.name))];
    const proxyUrl = await ensureProxy(this, callbackUrl);
    return originalRegister.call(this, proxyUrl, extended);
  };

  return SolPluginClient;
}

export const __test = { normalizedCount, handleTvTool, remoteEntityId };
