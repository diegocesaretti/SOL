import { randomBytes } from "node:crypto";
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
const mcpPath = `/mcp/${randomBytes(24).toString("base64url")}`;

let lastPersonSignature = "";
async function syncPeople() {
  if (config.personSync === "off" || !sol.enabled) return;
  const people = cache.listPeople();
  const signature = people.map((person) => `${person.entityId}:${person.attributes?.friendly_name || ""}`).sort().join("|");
  if (signature === lastPersonSignature) return;
  lastPersonSignature = signature;
  for (const person of people) {
    const label = person.attributes?.friendly_name || person.registry?.name || person.entityId;
    await sol.upsertPerson({
      entityId: person.entityId,
      label,
      autoLinkMember: config.personSync === "safe-link",
      metadata: { source: "home_assistant", entityId: person.entityId }
    }).catch((error) => console.warn(`SOL person sync failed for ${person.entityId}: ${error?.message || error}`));
  }
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
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiresSubmit: false
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
    requiresSubmit: false
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
    requiresSubmit: false
  },
  {
    name: "home_assistant_list_people",
    description: "List cached Home Assistant person entities and their current states.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiresSubmit: false
  },
  {
    name: "home_assistant_list_areas",
    description: "List Home Assistant areas from the cached area registry with current entity counts.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiresSubmit: false
  },
  {
    name: "home_assistant_get_services",
    description: "List cached Home Assistant service/action definitions, optionally filtered by domain.",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string" } },
      additionalProperties: false
    },
    requiresSubmit: false
  },
  {
    name: "home_assistant_call_service",
    description: "Execute a Home Assistant service/action. Requires SOL submit scope, plugin control enabled and explicit confirmation from the current human.",
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
    requiresSubmit: true
  }
];

const server = createServer(async (request, response) => {
  const path = new URL(request.url || "/", "http://127.0.0.1").pathname;
  try {
    if (request.method === "GET" && path === "/health") {
      sendJson(response, 200, { ok: true, provider: "home_assistant", cache: cache.status(), controlEnabled: config.allowControl });
      return;
    }
    if (request.method !== "POST" || path !== mcpPath) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    const body = await readJson(request);
    const tool = String(body?.tool || "");
    const args = body?.arguments && typeof body.arguments === "object" ? body.arguments : {};

    if (tool === "home_assistant_cache_status") {
      sendJson(response, 200, { cache: cache.status(), baseUrl: config.baseUrl, controlEnabled: config.allowControl });
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
      sendJson(response, 200, { people: cache.listPeople().map(compactEntity), cache: cache.status() });
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
      const result = await ha.callService(domain, service, args.serviceData || {}, args.target || {});
      sendJson(response, 200, { ok: true, result: result ?? null, cache: cache.status() });
      return;
    }
    sendJson(response, 404, { error: "tool_not_found" });
  } catch (error) {
    sendJson(response, 500, { error: error?.message || String(error) });
  }
});

server.listen(config.apiPort, "127.0.0.1", async () => {
  const callbackUrl = `http://127.0.0.1:${config.apiPort}${mcpPath}`;
  console.log(`Home Assistant SOL plugin API listening on loopback port ${config.apiPort}`);
  if (sol.enabled) {
    await sol.registerMcpTools(callbackUrl, tools).catch((error) => {
      console.warn(`SOL MCP tool registration failed: ${error?.message || error}`);
    });
  }
  void ha.start();
});

const peopleTimer = setInterval(() => void syncPeople(), 30000);
peopleTimer.unref?.();

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: stopping Home Assistant SOL plugin`);
  clearInterval(peopleTimer);
  server.close();
  await ha.stop();
  await presenceQueue.catch(() => undefined);
  await cache.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
