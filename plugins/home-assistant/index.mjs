import { createHash, randomBytes } from "node:crypto";
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
  tvActionSettleMs: numberEnv("HA_SOL_TV_ACTION_SETTLE_MS", 450, 100, 2000),
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

function assertTvActionAllowed() {
  if (!config.allowControl) throw new Error("home_assistant_control_disabled");
  tv.assertConfigured();
}

const TV_AGENT_POLICY = [
  "A direct human TV request authorizes the intermediate TV navigation actions needed to complete that request; do not ask for repeated confirmation for DPAD, click, tap, launch or text entry within that task.",
  "Treat the screenshot as visual ground truth. Accessibility is a useful hint, not proof that an element is absent.",
  "Track the visible focus/highlight after every action and use it as the primary reference for DPAD navigation.",
  "Before opening search, inspect all visible posters/results and select the requested target directly if it is already on screen.",
  "After every action inspect the returned post-action screenshot and UI tree before deciding the next action.",
  "If sameAsPreviousFrame is true after an action, do not blindly repeat the same action; change strategy, direction, click-by-text or visual tap.",
  "For unrelated permission dialogs, prefer Deny/Back and continue the requested task unless that permission is actually required."
];

let lastTvFrameSha256 = null;
function tvImageResult(screenshot, observation = null, extra = {}) {
  const frameSha256 = createHash("sha256").update(screenshot.buffer).digest("hex");
  const sameAsPreviousFrame = lastTvFrameSha256 !== null && lastTvFrameSha256 === frameSha256;
  lastTvFrameSha256 = frameSha256;
  const metadata = {
    source: "Codex TV Satellite",
    contentType: screenshot.contentType,
    bytes: screenshot.buffer.length,
    frameSha256,
    sameAsPreviousFrame,
    agentPolicy: TV_AGENT_POLICY,
    ...(observation ? { observation } : {}),
    ...extra
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function observeTvAfterAction(actionResult) {
  await sleep(config.tvActionSettleMs);
  const [observation, screenshot] = await Promise.all([tv.observe(), tv.screenshot()]);
  return tvImageResult(screenshot, observation, {
    postAction: true,
    actionResult,
    settleMs: config.tvActionSettleMs
  });
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

const TV_ACTION_DESCRIPTION_SUFFIX = " A direct human TV request authorizes intermediate actions for that task, so do not ask for repeated confirmation. This action automatically returns the post-action screenshot plus Accessibility tree. Inspect that result before the next action; image is ground truth and visible focus/highlight is the primary DPAD reference. If the frame does not change, switch strategy instead of blindly repeating the same action.";

const tvTools = [
  {
    name: "home_assistant_tv_status",
    description: "Check the configured Codex TV Satellite on the local network, including Android API level, Accessibility connection and screenshot readiness.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredScope: "read"
  },
  {
    name: "home_assistant_tv_observe",
    description: "Observe Android TV on demand. Returns the current screenshot as real MCP image content together with the Accessibility UI tree and navigation policy. Treat the screenshot as ground truth: first inspect visible posters/results and current focus; Accessibility may omit visually present elements. Use one action at a time, then inspect the returned post-action image.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredScope: "read"
  },
  {
    name: "home_assistant_tv_screenshot",
    description: "Capture the latest Android TV frame as real MCP image content. Use visual focus/highlight and visible content as authoritative evidence even when Accessibility does not expose an element.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredScope: "read"
  },
  {
    name: "home_assistant_tv_tap",
    description: "Tap a visual location on Android TV using normalized coordinates from 0 to 1. Use when an element is visible but not exposed by Accessibility." + TV_ACTION_DESCRIPTION_SUFFIX,
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", minimum: 0, maximum: 1, description: "Horizontal normalized coordinate, 0=left and 1=right." },
        y: { type: "number", minimum: 0, maximum: 1, description: "Vertical normalized coordinate, 0=top and 1=bottom." }
      },
      required: ["x", "y"],
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "home_assistant_tv_click_text",
    description: "Click an Android TV Accessibility element by visible text. Prefer this when the UI tree exposes a reliable label, but never infer that a visually present element is absent just because the tree omits it." + TV_ACTION_DESCRIPTION_SUFFIX,
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 240 }
      },
      required: ["text"],
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "home_assistant_tv_set_text",
    description: "Replace text in the currently focused editable Android TV field, for example a Stremio or YouTube search box. Reach and visibly focus the text field before using this tool." + TV_ACTION_DESCRIPTION_SUFFIX,
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 500 }
      },
      required: ["text"],
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "home_assistant_tv_launch_app",
    description: "Launch an installed Android TV app by package name or app label through Codex TV Satellite." + TV_ACTION_DESCRIPTION_SUFFIX,
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", minLength: 1, maxLength: 240 }
      },
      required: ["app"],
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "home_assistant_tv_navigate",
    description: "Navigate Android TV with Home, Back or DPAD. On Android 7/8, DPAD automatically falls back to the configured Home Assistant remote. Follow the visible focus/highlight after every move. Before opening search, inspect whether the requested poster/result is already visible." + TV_ACTION_DESCRIPTION_SUFFIX,
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["home", "back", "up", "down", "left", "right", "center"] }
      },
      required: ["direction"],
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
          remoteFallbackEntityId: config.tvRemoteEntityId || null,
          actionAutoObserve: true,
          actionSettleMs: config.tvActionSettleMs
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
        controlEnabled: config.allowControl,
        actionAutoObserve: true,
        actionSettleMs: config.tvActionSettleMs,
        agentPolicy: TV_AGENT_POLICY
      });
      return;
    }
    if (tool === "home_assistant_tv_observe") {
      const [observation, screenshot] = await Promise.all([tv.observe(), tv.screenshot()]);
      sendJson(response, 200, tvImageResult(screenshot, observation, { postAction: false }));
      return;
    }
    if (tool === "home_assistant_tv_screenshot") {
      const screenshot = await tv.screenshot();
      sendJson(response, 200, tvImageResult(screenshot));
      return;
    }
    if (tool === "home_assistant_tv_tap") {
      assertTvActionAllowed();
      const x = Number(args.x);
      const y = Number(args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
        sendJson(response, 400, { error: "tv_tap_coordinates_must_be_normalized_0_to_1" });
        return;
      }
      const actionResult = await tv.action("tap", { x, y });
      sendJson(response, 200, await observeTvAfterAction(actionResult));
      return;
    }
    if (tool === "home_assistant_tv_click_text") {
      assertTvActionAllowed();
      const text = String(args.text || "").trim();
      if (!text) {
        sendJson(response, 400, { error: "tv_text_required" });
        return;
      }
      const actionResult = await tv.action("click_text", { text });
      sendJson(response, 200, await observeTvAfterAction(actionResult));
      return;
    }
    if (tool === "home_assistant_tv_set_text") {
      assertTvActionAllowed();
      const text = String(args.text || "");
      if (!text) {
        sendJson(response, 400, { error: "tv_text_required" });
        return;
      }
      const actionResult = await tv.action("set_text", { text });
      sendJson(response, 200, await observeTvAfterAction(actionResult));
      return;
    }
    if (tool === "home_assistant_tv_launch_app") {
      assertTvActionAllowed();
      const app = String(args.app || "").trim();
      if (!app) {
        sendJson(response, 400, { error: "tv_app_required" });
        return;
      }
      const actionResult = await tv.action("launch_app", { app });
      sendJson(response, 200, await observeTvAfterAction(actionResult));
      return;
    }
    if (tool === "home_assistant_tv_navigate") {
      assertTvActionAllowed();
      const direction = String(args.direction || "").trim().toLowerCase();
      const actionResult = await navigateTv(direction);
      sendJson(response, 200, await observeTvAfterAction(actionResult));
      return;
    }
    sendJson(response, 404, { error: "tool_not_found" });
  } catch (error) {
    const message = error?.message || String(error);
    const status = message.includes("disabled") ? 403
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
