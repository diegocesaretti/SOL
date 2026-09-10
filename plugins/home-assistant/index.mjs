import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { HaStateCache } from "./lib/cache.mjs";
import { HomeAssistantClient } from "./lib/ha-client.mjs";
import { SolPluginClient } from "./lib/sol-client.mjs";
import { TvSatelliteClient } from "./lib/tv-client.mjs";

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
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 1024 * 1024) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function compactEntity(entity) {
  if (!entity) return null;
  return {
    entityId: entity.entityId,
    domain: entity.domain,
    state: entity.state,
    friendlyName: entity.attributes?.friendly_name || entity.registry?.name || entity.registry?.original_name || null,
    area: entity.area?.name || null,
    areaId: entity.areaId,
    device: entity.device?.name_by_user || entity.device?.name || entity.parentDevice?.name_by_user || entity.parentDevice?.name || null,
    attributes: entity.attributes,
    lastChanged: entity.lastChanged,
    lastUpdated: entity.lastUpdated
  };
}

const config = {
  baseUrl: required("HA_URL").replace(/\/$/, ""),
  token: required("HA_TOKEN"),
  apiPort: numberEnv("HA_SOL_API_PORT", 8767, 1024, 65535),
  flushMs: numberEnv("HA_SOL_CACHE_FLUSH_MS", 2000, 250, 60000),
  reconcileSeconds: numberEnv("HA_SOL_RECONCILE_SECONDS", 300, 30, 3600),
  personSync: process.env.HA_SOL_PERSON_SYNC?.trim() || "safe-link",
  ingestPresence: boolEnv("HA_SOL_INGEST_PRESENCE", true),
  allowControl: boolEnv("HA_SOL_ALLOW_CONTROL", false),
  tvEnabled: boolEnv("HA_SOL_TV_ENABLED", false),
  tvUrl: process.env.HA_SOL_TV_URL?.trim() || "",
  tvToken: process.env.HA_SOL_TV_TOKEN?.trim() || "",
  tvRemoteEntityId: process.env.HA_SOL_TV_REMOTE_ENTITY_ID?.trim() || "",
  tvTimeoutMs: numberEnv("HA_SOL_TV_TIMEOUT_MS", 8000, 1000, 30000),
  dataDir: process.env.SOL_PLUGIN_DATA_DIR || new URL("./.data", import.meta.url).pathname
};

await mkdir(config.dataDir, { recursive: true });
const cache = new HaStateCache(config.dataDir, config.flushMs);
await cache.load();
const sol = new SolPluginClient();
const tv = new TvSatelliteClient({
  enabled: config.tvEnabled,
  baseUrl: config.tvUrl,
  token: config.tvToken,
  timeoutMs: config.tvTimeoutMs
});
const pluginId = process.env.SOL_PLUGIN_ID?.trim() || "home-assistant";
const mcpPath = `/mcp/${randomBytes(24).toString("base64url")}`;
const callbackUrl = `http://127.0.0.1:${config.apiPort}${mcpPath}`;
const personBindings = new Map();

function personBindingSummary(binding) {
  if (!binding) return null;
  return {
    entityId: binding.entityId,
    linkedToSolMember: Boolean(binding.linkedMemberId),
    linkedBy: binding.linkedBy || "none"
  };
}

function compactPerson(entity) {
  return {
    ...compactEntity(entity),
    solPerson: personBindingSummary(personBindings.get(entity.entityId)),
    semantics: "Person is a human identity; this binding does not grant SOL account access or permissions."
  };
}

function personSyncStatus() {
  const people = cache.listPeople();
  return {
    mode: config.personSync,
    cachedPeople: people.length,
    resolvedToSol: people.filter((person) => personBindings.has(person.entityId)).length,
    grantsAccess: false
  };
}

let lastPersonSignature = "";
let personSyncRun = null;
async function syncPeopleOnce() {
  if (config.personSync === "off" || !sol.enabled) return;
  const people = cache.listPeople();
  const signature = people.map((person) => `${person.entityId}:${person.attributes?.friendly_name || ""}`).sort().join("|");
  if (signature === lastPersonSignature && people.every((person) => personBindings.has(person.entityId))) return;

  const liveIds = new Set(people.map((person) => person.entityId));
  for (const entityId of personBindings.keys()) {
    if (!liveIds.has(entityId)) personBindings.delete(entityId);
  }

  let allSucceeded = true;
  for (const person of people) {
    const label = person.attributes?.friendly_name || person.registry?.name || person.entityId;
    try {
      const binding = await sol.upsertPerson({
        entityId: person.entityId,
        label,
        autoLinkMember: config.personSync === "safe-link",
        metadata: { source: "home_assistant", entityId: person.entityId }
      });
      if (binding?.entityId) personBindings.set(person.entityId, binding);
    } catch (error) {
      allSucceeded = false;
      console.warn(`SOL person sync failed for ${person.entityId}: ${error?.message || error}`);
    }
  }
  if (allSucceeded) lastPersonSignature = signature;
}

async function syncPeople() {
  if (personSyncRun) return personSyncRun;
  personSyncRun = syncPeopleOnce().finally(() => { personSyncRun = null; });
  return personSyncRun;
}

let presenceQueue = Promise.resolve();
async function onStateChanged(event) {
  const next = event?.data?.new_state;
  if (!next?.entity_id?.startsWith("person.")) return;
  void syncPeople();
  if (!config.ingestPresence || !sol.enabled) return;
  presenceQueue = presenceQueue
    .then(() => sol.ingestPresence(config.baseUrl, next))
    .catch((error) => console.warn(`SOL presence ingest failed: ${error?.message || error}`));
}

async function onConnectionState(state, error) {
  if (!sol.enabled) return;
  const status = state === "connected" ? "connected" : state === "error" ? "error" : "disconnected";
  await sol.setInputStatus(config.baseUrl, status, state === "connected" ? new Date().toISOString() : undefined)
    .catch((requestError) => console.warn(`SOL HA input status update failed: ${requestError?.message || requestError}`));
  if (state === "connected") void syncPeople();
  if (state === "error") {
    console.log(JSON.stringify({
      type: "sol.plugin.health",
      status: "degraded",
      details: { provider: "home_assistant", error: error?.message || String(error || "connection_error") }
    }));
  }
}

const ha = new HomeAssistantClient({
  baseUrl: config.baseUrl,
  token: config.token,
  cache,
  reconcileSeconds: config.reconcileSeconds,
  onStateChanged,
  onConnectionState
});

function assertTvActionAllowed(args) {
  if (!config.allowControl) throw new Error("home_assistant_control_disabled");
  if (args.confirmedByUser !== true) throw new Error("explicit_user_confirmation_required");
  tv.assertConfigured();
}

function tvImageResult(screenshot, observation = null) {
  const metadata = {
    source: "Codex TV Satellite",
    contentType: screenshot.contentType,
    bytes: screenshot.buffer.length,
    ...(observation ? { observation } : {})
  };
  return {
    __sol_mcp_content: [
      {
        type: "image",
        mimeType: screenshot.contentType,
        data: screenshot.buffer.toString("base64")
      },
      {
        type: "text",
        text: JSON.stringify(metadata, null, 2)
      }
    ]
  };
}

const satelliteNavigationAction = {
  home: "home",
  back: "back",
  up: "dpad_up",
  down: "dpad_down",
  left: "dpad_left",
  right: "dpad_right",
  center: "dpad_center"
};

const homeAssistantRemoteCommand = {
  home: "HOME",
  back: "BACK",
  up: "DPAD_UP",
  down: "DPAD_DOWN",
  left: "DPAD_LEFT",
  right: "DPAD_RIGHT",
  center: "DPAD_CENTER"
};

async function navigateTv(direction) {
  const action = satelliteNavigationAction[direction];
  if (!action) throw new Error("tv_navigation_direction_invalid");
  const result = await tv.action(action);
  if (result.ok === true) return { ok: true, via: "tv_satellite", result };

  const canFallback = Boolean(config.tvRemoteEntityId) &&
    (result.fallback === "home_assistant" || direction === "home" || direction === "back");
  if (!canFallback) {
    return {
      ok: false,
      via: "tv_satellite",
      result,
      hint: config.tvRemoteEntityId
        ? "The Satellite action failed and did not advertise a Home Assistant fallback."
        : "Configure tv_remote_entity_id to enable Home Assistant remote fallback on Android 7/8."
    };
  }

  const command = homeAssistantRemoteCommand[direction];
  const fallbackResult = await ha.callService(
    "remote",
    "send_command",
    { command: [command] },
    { entity_id: config.tvRemoteEntityId },
    false
  );
  return {
    ok: true,
    via: "home_assistant_remote_fallback",
    entityId: config.tvRemoteEntityId,
    command,
    satelliteResult: result,
    result: fallbackResult ?? null
  };
}

const baseTools = [
  {
    name: "home_assistant_cache_status",
    description: "Return Home Assistant connection, local cache freshness and Person sync status. Use this before relying on cached state when freshness matters.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredScope: "read"
  },
  {
    name: "home_assistant_get_state",
    description: "Read one Home Assistant entity from SOL's event-driven local cache without a network read to Home Assistant.",
    inputSchema: {
      type: "object",
      properties: { entityId: { type: "string", description: "Exact Home Assistant entity_id." } },
      required: ["entityId"],
      additionalProperties: false
    },
    requiredScope: "read"
  },
  {
    name: "home_assistant_search_states",
    description: "Search cached Home Assistant entities by entity id, friendly name, device or area. Prefer this over guessing entity ids.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 100 }
      },
      required: ["query"],
      additionalProperties: false
    },
    requiredScope: "read"
  },
  {
    name: "home_assistant_list_people",
    description: "List cached Home Assistant person entities with their canonical SOL Person binding. Person identity does not imply a SOL account or access grant.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredScope: "read"
  },
  {
    name: "home_assistant_list_areas",
    description: "List Home Assistant areas from the cached area registry with current entity counts.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredScope: "read"
  },
  {
    name: "home_assistant_get_services",
    description: "List cached Home Assistant service/action definitions, optionally filtered by domain.",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string" } },
      additionalProperties: false
    },
    requiredScope: "read"
  },
  {
    name: "home_assistant_call_service",
    description: "Execute a Home Assistant service/action. Requires SOL actions scope, plugin control enabled and explicit confirmation from the current human.",
    inputSchema: {
      type: "object",
      properties: {
        confirmedByUser: { type: "boolean", const: true },
        domain: { type: "string" },
        service: { type: "string" },
        target: { type: "object" },
        serviceData: { type: "object" }
      },
      required: ["confirmedByUser", "domain", "service"],
      additionalProperties: false
    },
    requiredScope: "actions"
  }
];

const tvTools = [
  {
    name: "home_assistant_tv_status",
    description: "Check the configured Codex TV Satellite on the local network, including Android API level, Accessibility connection and screenshot readiness.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredScope: "read"
  },
  {
    name: "home_assistant_tv_observe",
    description: "Observe Android TV on demand. Returns the current screenshot as real MCP image content together with the Accessibility UI tree and capabilities. Prefer this after every TV action instead of polling continuously.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredScope: "read"
  },
  {
    name: "home_assistant_tv_screenshot",
    description: "Capture the latest Android TV frame as real MCP image content so Codex can visually inspect the television screen.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredScope: "read"
  },
  {
    name: "home_assistant_tv_tap",
    description: "Tap a visual location on Android TV using normalized coordinates from 0 to 1. Designed for Android 7+ Accessibility gesture injection after visually inspecting the screen.",
    inputSchema: {
      type: "object",
      properties: {
        confirmedByUser: { type: "boolean", const: true },
        x: { type: "number", minimum: 0, maximum: 1, description: "Horizontal normalized coordinate, 0=left and 1=right." },
        y: { type: "number", minimum: 0, maximum: 1, description: "Vertical normalized coordinate, 0=top and 1=bottom." }
      },
      required: ["confirmedByUser", "x", "y"],
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "home_assistant_tv_click_text",
    description: "Click an Android TV Accessibility element by its visible text. Prefer this over coordinate taps when the UI tree exposes a useful label.",
    inputSchema: {
      type: "object",
      properties: {
        confirmedByUser: { type: "boolean", const: true },
        text: { type: "string", minLength: 1, maxLength: 240 }
      },
      required: ["confirmedByUser", "text"],
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "home_assistant_tv_set_text",
    description: "Replace text in the currently focused editable Android TV field, for example a Stremio or YouTube search box.",
    inputSchema: {
      type: "object",
      properties: {
        confirmedByUser: { type: "boolean", const: true },
        text: { type: "string", minLength: 1, maxLength: 500 }
      },
      required: ["confirmedByUser", "text"],
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "home_assistant_tv_launch_app",
    description: "Launch an installed Android TV app by package name or app label through Codex TV Satellite.",
    inputSchema: {
      type: "object",
      properties: {
        confirmedByUser: { type: "boolean", const: true },
        app: { type: "string", minLength: 1, maxLength: 240 }
      },
      required: ["confirmedByUser", "app"],
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "home_assistant_tv_navigate",
    description: "Navigate Android TV with Home, Back or DPAD. On Android 7/8, DPAD automatically falls back to the configured Home Assistant remote entity when the Satellite reports native DPAD unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        confirmedByUser: { type: "boolean", const: true },
        direction: { type: "string", enum: ["home", "back", "up", "down", "left", "right", "center"] }
      },
      required: ["confirmedByUser", "direction"],
      additionalProperties: false
    },
    requiredScope: "actions"
  }
];

const tools = tv.configured ? [...baseTools, ...tvTools] : baseTools;

let toolsRegistered = false;
async function registerTools() {
  if (!sol.enabled) return;
  try {
    await sol.registerMcpTools(callbackUrl, tools);
    toolsRegistered = true;
  } catch (error) {
    toolsRegistered = false;
    console.warn(`SOL MCP tool registration failed: ${error?.message || error}`);
  }
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url || "/", "http://127.0.0.1").pathname;
  try {
    if (request.method === "GET" && path === "/health") {
      sendJson(response, 200, {
        ok: true,
        provider: "home_assistant",
        cache: cache.status(),
        personSync: personSyncStatus(),
        controlEnabled: config.allowControl,
        tv: {
          ...tv.summary(),
          remoteFallbackEntityId: config.tvRemoteEntityId || null
        }
      });
      return;
    }
    if (request.method !== "POST" || path !== mcpPath) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    const body = await readJson(request);
    if (body?.type === "sol.plugin.mcp.probe") {
      if (body.pluginId !== pluginId) {
        sendJson(response, 403, { error: "plugin_id_mismatch" });
        return;
      }
      sendJson(response, 200, { ok: true, pluginId });
      return;
    }
    if (body?.type !== "sol.plugin.mcp.invoke" || body.pluginId !== pluginId) {
      sendJson(response, 403, { error: "invalid_plugin_mcp_envelope" });
      return;
    }

    const tool = String(body?.tool || "");
    const args = body?.arguments && typeof body.arguments === "object" ? body.arguments : {};

    if (tool === "home_assistant_cache_status") {
      sendJson(response, 200, {
        cache: cache.status(),
        baseUrl: config.baseUrl,
        personSync: personSyncStatus(),
        controlEnabled: config.allowControl,
        tv: tv.summary()
      });
      return;
    }
    if (tool === "home_assistant_get_state") {
      const entity = cache.getEntity(String(args.entityId || ""));
      if (!entity) {
        sendJson(response, 404, { error: "entity_not_found" });
        return;
      }
      sendJson(response, 200, compactEntity(entity));
      return;
    }
    if (tool === "home_assistant_search_states") {
      sendJson(response, 200, {
        results: cache.search(String(args.query || ""), Number(args.limit || 30)).map(compactEntity),
        cache: cache.status()
      });
      return;
    }
    if (tool === "home_assistant_list_people") {
      await syncPeople().catch(() => undefined);
      sendJson(response, 200, {
        people: cache.listPeople().map(compactPerson),
        personSync: personSyncStatus(),
        cache: cache.status()
      });
      return;
    }
    if (tool === "home_assistant_list_areas") {
      sendJson(response, 200, { areas: cache.listAreas(), cache: cache.status() });
      return;
    }
    if (tool === "home_assistant_get_services") {
      const domain = typeof args.domain === "string" ? args.domain.trim() : "";
      sendJson(response, 200, {
        services: domain ? { [domain]: cache.services[domain] || {} } : cache.services,
        cache: cache.status()
      });
      return;
    }
    if (tool === "home_assistant_call_service") {
      if (!config.allowControl) {
        sendJson(response, 403, { error: "home_assistant_control_disabled" });
        return;
      }
      if (args.confirmedByUser !== true) {
        sendJson(response, 403, { error: "explicit_user_confirmation_required" });
        return;
      }
      const domain = String(args.domain || "").trim();
      const service = String(args.service || "").trim();
      if (!domain || !service) {
        sendJson(response, 400, { error: "domain_and_service_required" });
        return;
      }
      const serviceDefinition = cache.services?.[domain]?.[service];
      const returnResponse = Boolean(serviceDefinition?.response);
      const result = await ha.callService(domain, service, args.serviceData || {}, args.target || {}, returnResponse);
      sendJson(response, 200, { ok: true, result: result ?? null, cache: cache.status() });
      return;
    }
    if (tool === "home_assistant_tv_status") {
      sendJson(response, 200, {
        ...(await tv.health()),
        remoteFallbackEntityId: config.tvRemoteEntityId || null,
        controlEnabled: config.allowControl
      });
      return;
    }
    if (tool === "home_assistant_tv_observe") {
      const [observation, screenshot] = await Promise.all([tv.observe(), tv.screenshot()]);
      sendJson(response, 200, tvImageResult(screenshot, observation));
      return;
    }
    if (tool === "home_assistant_tv_screenshot") {
      const screenshot = await tv.screenshot();
      sendJson(response, 200, tvImageResult(screenshot));
      return;
    }
    if (tool === "home_assistant_tv_tap") {
      assertTvActionAllowed(args);
      const x = Number(args.x);
      const y = Number(args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
        sendJson(response, 400, { error: "tv_tap_coordinates_must_be_normalized_0_to_1" });
        return;
      }
      sendJson(response, 200, await tv.action("tap", { x, y }));
      return;
    }
    if (tool === "home_assistant_tv_click_text") {
      assertTvActionAllowed(args);
      const text = String(args.text || "").trim();
      if (!text) {
        sendJson(response, 400, { error: "tv_text_required" });
        return;
      }
      sendJson(response, 200, await tv.action("click_text", { text }));
      return;
    }
    if (tool === "home_assistant_tv_set_text") {
      assertTvActionAllowed(args);
      const text = String(args.text || "");
      if (!text) {
        sendJson(response, 400, { error: "tv_text_required" });
        return;
      }
      sendJson(response, 200, await tv.action("set_text", { text }));
      return;
    }
    if (tool === "home_assistant_tv_launch_app") {
      assertTvActionAllowed(args);
      const app = String(args.app || "").trim();
      if (!app) {
        sendJson(response, 400, { error: "tv_app_required" });
        return;
      }
      sendJson(response, 200, await tv.action("launch_app", { app }));
      return;
    }
    if (tool === "home_assistant_tv_navigate") {
      assertTvActionAllowed(args);
      const direction = String(args.direction || "").trim().toLowerCase();
      sendJson(response, 200, await navigateTv(direction));
      return;
    }
    sendJson(response, 404, { error: "tool_not_found" });
  } catch (error) {
    const message = error?.message || String(error);
    const status = message.includes("disabled") || message.includes("confirmation") ? 403
      : message.includes("not_found") ? 404
        : 500;
    sendJson(response, status, { error: message });
  }
});

server.listen(config.apiPort, "127.0.0.1", async () => {
  console.log(`Home Assistant SOL plugin API listening on loopback port ${config.apiPort}`);
  if (config.tvEnabled && !tv.configured) {
    console.warn("Android TV Satellite is enabled but HA_SOL_TV_URL or HA_SOL_TV_TOKEN is missing; TV tools will not be registered.");
  }
  await registerTools();
  void ha.start();
});

const peopleTimer = setInterval(() => void syncPeople(), 30000);
peopleTimer.unref?.();
const registrationRetryTimer = setInterval(() => {
  if (!toolsRegistered) void registerTools();
}, 15000);
registrationRetryTimer.unref?.();

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: stopping Home Assistant SOL plugin`);
  clearInterval(peopleTimer);
  clearInterval(registrationRetryTimer);
  if (sol.enabled) await sol.registerMcpTools(callbackUrl, []).catch(() => undefined);
  server.close();
  await ha.stop();
  await personSyncRun?.catch(() => undefined);
  await presenceQueue.catch(() => undefined);
  await cache.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
