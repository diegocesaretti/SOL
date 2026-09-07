import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { HaStateCache } from "./lib/cache.mjs";
import { HomeAssistantClient } from "./lib/ha-client.mjs";
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

function parseObjectJson(value, name) {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "string") throw new Error(`${name}_must_be_json_text`);
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${name}_invalid_json`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${name}_must_be_object`);
  return parsed;
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
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
  dataDir: process.env.SOL_PLUGIN_DATA_DIR || new URL("./.data", import.meta.url).pathname
};

await mkdir(config.dataDir, { recursive: true });
const cache = new HaStateCache(config.dataDir, config.flushMs);
await cache.load();
const sol = new SolPluginClient();
const runtimeToken = process.env.SOL_PLUGIN_TOKEN?.trim() || "";
const toolCapability = randomBytes(24).toString("base64url");
const toolBasePath = `/tools/${toolCapability}`;
const toolBaseUrl = `http://127.0.0.1:${config.apiPort}${toolBasePath}`;

let lastPersonSignature = "";
async function syncPeople() {
  if (config.personSync === "off" || !sol.enabled) return;
  const people = cache.listPeople();
  const signature = people.map((person) => `${person.entityId}:${person.attributes?.friendly_name || ""}`).sort().join("|");
  if (signature === lastPersonSignature) return;
  let allSucceeded = true;
  for (const person of people) {
    const label = person.attributes?.friendly_name || person.registry?.name || person.entityId;
    try {
      await sol.upsertPerson({
        entityId: person.entityId,
        label,
        autoLinkMember: config.personSync === "safe-link",
        metadata: { source: "home_assistant", entityId: person.entityId }
      });
    } catch (error) {
      allSucceeded = false;
      console.warn(`SOL person sync failed for ${person.entityId}: ${error?.message || error}`);
    }
  }
  if (allSucceeded) lastPersonSignature = signature;
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

const tools = [
  {
    name: "home_assistant_cache_status",
    description: "Return Home Assistant connection and local cache freshness. Use this before relying on cached state when freshness matters.",
    requiresSubmit: false,
    input: []
  },
  {
    name: "home_assistant_get_state",
    description: "Read one Home Assistant entity from SOL's event-driven local cache without a network read to Home Assistant.",
    requiresSubmit: false,
    input: [{ name: "entityId", type: "string", description: "Exact Home Assistant entity_id.", required: true, min: 1, max: 255 }]
  },
  {
    name: "home_assistant_search_states",
    description: "Search cached Home Assistant entities by entity id, friendly name, device or area. Prefer this over guessing entity ids.",
    requiresSubmit: false,
    input: [
      { name: "query", type: "string", required: true, min: 1, max: 240 },
      { name: "limit", type: "number", required: false, min: 1, max: 100 }
    ]
  },
  {
    name: "home_assistant_list_people",
    description: "List cached Home Assistant person entities and their current states.",
    requiresSubmit: false,
    input: []
  },
  {
    name: "home_assistant_list_areas",
    description: "List Home Assistant areas from the cached area registry with current entity counts.",
    requiresSubmit: false,
    input: []
  },
  {
    name: "home_assistant_get_services",
    description: "List cached Home Assistant service/action definitions, optionally filtered by domain.",
    requiresSubmit: false,
    input: [{ name: "domain", type: "string", required: false, max: 120 }]
  },
  {
    name: "home_assistant_call_service",
    description: "Execute a Home Assistant service/action. Requires SOL external_action MCP scope, plugin control enabled and explicit confirmation from the current human.",
    requiresSubmit: true,
    input: [
      { name: "confirmedByUser", type: "boolean", required: true, literalTrue: true },
      { name: "domain", type: "string", required: true, min: 1, max: 120 },
      { name: "service", type: "string", required: true, min: 1, max: 120 },
      { name: "entityIds", type: "string_array", required: false, max: 50 },
      { name: "deviceIds", type: "string_array", required: false, max: 50 },
      { name: "areaIds", type: "string_array", required: false, max: 50 },
      { name: "serviceDataJson", type: "string", description: "Optional JSON object with Home Assistant service_data.", required: false, max: 20000 }
    ]
  }
];

let toolsRegistered = false;
async function registerTools() {
  if (!sol.enabled) return;
  try {
    await sol.registerTools(toolBaseUrl, tools);
    toolsRegistered = true;
  } catch (error) {
    toolsRegistered = false;
    console.warn(`SOL plugin tool registration failed: ${error?.message || error}`);
  }
}

async function invokeTool(tool, args) {
  if (tool === "home_assistant_cache_status") {
    return { cache: cache.status(), baseUrl: config.baseUrl, controlEnabled: config.allowControl };
  }
  if (tool === "home_assistant_get_state") {
    const entity = cache.getEntity(String(args.entityId || ""));
    if (!entity) throw new Error("entity_not_found");
    return compactEntity(entity);
  }
  if (tool === "home_assistant_search_states") {
    return { results: cache.search(String(args.query || ""), Number(args.limit || 30)).map(compactEntity), cache: cache.status() };
  }
  if (tool === "home_assistant_list_people") {
    return { people: cache.listPeople().map(compactEntity), cache: cache.status() };
  }
  if (tool === "home_assistant_list_areas") {
    return { areas: cache.listAreas(), cache: cache.status() };
  }
  if (tool === "home_assistant_get_services") {
    const domain = typeof args.domain === "string" ? args.domain.trim() : "";
    return { services: domain ? { [domain]: cache.services[domain] || {} } : cache.services, cache: cache.status() };
  }
  if (tool === "home_assistant_call_service") {
    if (!config.allowControl) throw new Error("home_assistant_control_disabled");
    if (args.confirmedByUser !== true) throw new Error("explicit_user_confirmation_required");
    const domain = String(args.domain || "").trim();
    const service = String(args.service || "").trim();
    if (!domain || !service) throw new Error("domain_and_service_required");
    const target = {};
    if (Array.isArray(args.entityIds) && args.entityIds.length) target.entity_id = args.entityIds;
    if (Array.isArray(args.deviceIds) && args.deviceIds.length) target.device_id = args.deviceIds;
    if (Array.isArray(args.areaIds) && args.areaIds.length) target.area_id = args.areaIds;
    const serviceData = parseObjectJson(args.serviceDataJson, "service_data");
    const serviceDefinition = cache.services?.[domain]?.[service];
    const returnResponse = Boolean(serviceDefinition?.response);
    const result = await ha.callService(domain, service, serviceData, target, returnResponse);
    return { ok: true, result: result ?? null, cache: cache.status() };
  }
  throw new Error("tool_not_found");
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url || "/", "http://127.0.0.1").pathname;
  try {
    if (request.method === "GET" && path === "/health") {
      sendJson(response, 200, { ok: true, provider: "home_assistant", cache: cache.status(), controlEnabled: config.allowControl });
      return;
    }
    const prefix = `${toolBasePath}/api/sol-tools/`;
    if (request.method !== "POST" || !path.startsWith(prefix)) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (!runtimeToken || !constantTimeEqual(request.headers.authorization, `Bearer ${runtimeToken}`)) {
      sendJson(response, 401, { error: "plugin_token_invalid" });
      return;
    }
    const tool = decodeURIComponent(path.slice(prefix.length));
    const args = await readJson(request);
    const result = await invokeTool(tool, args && typeof args === "object" && !Array.isArray(args) ? args : {});
    sendJson(response, 200, result);
  } catch (error) {
    const message = error?.message || String(error);
    const status = message === "entity_not_found" || message === "tool_not_found" ? 404
      : message.includes("disabled") || message.includes("confirmation") ? 403
        : 400;
    sendJson(response, status, { error: message });
  }
});

server.listen(config.apiPort, "127.0.0.1", async () => {
  console.log(`Home Assistant SOL plugin API listening on loopback port ${config.apiPort}`);
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
  if (sol.enabled) await sol.registerTools(toolBaseUrl, []).catch(() => undefined);
  server.close();
  await ha.stop();
  await presenceQueue.catch(() => undefined);
  await cache.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
