import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { inspectBambuddyPatches, launchBambuddyPatch } from "./lib/bambuddy-patcher.mjs";
import { SolPluginClientCore } from "./lib/sol-client-core.mjs";

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  return value === undefined ? fallback : /^(1|true|yes|on)$/i.test(value);
}
function numberEnv(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value))) : fallback;
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
    if (total > 2 * 1024 * 1024) throw new Error("request_too_large");
    chunks.push(b);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
const config = {
  baseUrl: (process.env.BAMBUDDY_URL || "http://127.0.0.1:8000").replace(/\/$/, ""),
  apiKey: process.env.BAMBUDDY_API_KEY?.trim() || "",
  apiPort: numberEnv("BAMBUDDY_SOL_API_PORT", 8770, 1024, 65535),
  allowControl: boolEnv("BAMBUDDY_SOL_ALLOW_CONTROL", true),
  filesCacheHours: numberEnv("BAMBUDDY_FILES_CACHE_HOURS", 24, 1, 168),
  bambuddyInstallDir: process.env.BAMBUDDY_INSTALL_DIR?.trim() || "C:\\Program Files\\Bambuddy",
  maintainPatches: boolEnv("BAMBUDDY_MAINTAIN_PATCHES", true)
};

const pluginDataDir = process.env.SOL_PLUGIN_DATA_DIR?.trim()
  || join(process.env.SOL_PLUGIN_ROOT?.trim() || process.cwd(), ".data");
const filesCachePath = join(pluginDataDir, "files-cache.json");
const filesCacheTtlMs = config.filesCacheHours * 60 * 60 * 1000;

const sol = new SolPluginClientCore();
const pluginId = process.env.SOL_PLUGIN_ID?.trim() || "bambuddy";
const mcpPath = `/mcp/${randomBytes(24).toString("base64url")}`;
const callbackUrl = `http://127.0.0.1:${config.apiPort}${mcpPath}`;

function queryString(query = {}) {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) for (const item of value) out.append(key, String(item));
    else out.set(key, String(value));
  }
  const s = out.toString();
  return s ? `?${s}` : "";
}
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (/^(access_code|password|secret|authorization|api_key)$/i.test(key)) out[key] = "[redacted]";
    else out[key] = sanitize(val);
  }
  return out;
}

async function api(path, { method = "GET", query, body, timeout = 45000 } = {}) {
  if (!String(path).startsWith("/")) throw new Error("invalid_api_path");
  const response = await fetch(`${config.baseUrl}${path}${queryString(query)}`, {
    method,
    headers: {
      accept: "application/json",
      ...(config.apiKey ? { "X-API-Key": config.apiKey } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeout)
  });
  const type = response.headers.get("content-type") || "";
  const payload = type.includes("application/json")
    ? await response.json().catch(() => ({}))
    : await response.text().catch(() => "");
  if (!response.ok) {
    const detail = payload?.detail || payload?.error
      || (typeof payload === "string" ? payload : JSON.stringify(payload))
      || `Bambuddy HTTP ${response.status}`;
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }
  return sanitize(payload);
}

async function listPrinters() {
  const value = await api("/api/v1/printers/");
  return Array.isArray(value) ? value : (Array.isArray(value?.value) ? value.value : []);
}

let filesCache = { version: 1, updatedAt: null, printers: {} };
let filesCacheLoaded = false;
let filesCacheWrite = Promise.resolve();

function filesCacheKey(printer) {
  return String(printer?.serial_number || `id:${printer?.id}`);
}
function filesCacheEntry(printer) {
  return filesCache.printers?.[filesCacheKey(printer)] || null;
}
function filesCacheFresh(entry) {
  const ts = Date.parse(entry?.updatedAt || "");
  return Number.isFinite(ts) && (Date.now() - ts) <= filesCacheTtlMs;
}
async function loadFilesCache() {
  if (filesCacheLoaded) return filesCache;
  filesCacheLoaded = true;
  try {
    const raw = await readFile(filesCachePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && parsed.printers && typeof parsed.printers === "object") {
      filesCache = parsed;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`Bambuddy files cache load failed: ${error?.message || error}`);
  }
  return filesCache;
}
async function saveFilesCache() {
  filesCacheWrite = filesCacheWrite.then(async () => {
    await mkdir(pluginDataDir, { recursive: true });
    filesCache.updatedAt = new Date().toISOString();
    const tempPath = `${filesCachePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(filesCache, null, 2), "utf8");
    await rename(tempPath, filesCachePath);
  }).catch((error) => {
    console.warn(`Bambuddy files cache save failed: ${error?.message || error}`);
  });
  return filesCacheWrite;
}
async function refreshPrinterFilesCache(printer) {
  await loadFilesCache();
  const listing = await api(`/api/v1/printers/${printer.id}/files`, { query: { path: "/" } });
  const entry = {
    printer: {
      id: printer.id,
      name: printer.name,
      serial_number: printer.serial_number,
      model: printer.model || null
    },
    path: "/",
    updatedAt: new Date().toISOString(),
    files: Array.isArray(listing?.files) ? listing.files : [],
    warnings: Array.isArray(listing?.warnings) ? listing.warnings : []
  };
  filesCache.printers[filesCacheKey(printer)] = entry;
  await saveFilesCache();
  return entry;
}
async function refreshAllFilesCache() {
  await loadFilesCache();
  const printers = await listPrinters();
  const results = [];
  for (const printer of printers) {
    try {
      const entry = await refreshPrinterFilesCache(printer);
      results.push({ printer: printer.name, ok: true, count: entry.files.length, updatedAt: entry.updatedAt });
    } catch (error) {
      results.push({ printer: printer.name, ok: false, error: error?.message || String(error) });
    }
  }
  return results;
}
function printActionHints(printer) {
  return {
    preferred: {
      tool: "bambuddy_print_sd",
      via: "sol_run_action",
      confirmedByUser: true,
      arguments: {
        printer: printer.name,
        file: "<exact .3mf filename from files[]>"
      }
    },
    fallbackWhenDirectToolIsMissing: {
      tool: "bambuddy_api_action",
      confirmedByUser: true,
      method: "POST",
      path: `/api/v1/printers/${printer.id}/print-sd`,
      query: {
        filename: "<exact .3mf filename from files[]>",
        plate_id: 1
      },
      note: "Use this fallback when the client/chat catalog does not expose bambuddy_print_sd. Add use_ams=true and ams_mapping only when AMS printing is intended."
    }
  };
}

async function filesForPrinter(printer, { path = "/", refresh = false } = {}) {
  const normalizedPath = String(path || "/");
  if (normalizedPath !== "/") {
    const listing = await api(`/api/v1/printers/${printer.id}/files`, { query: { path: normalizedPath } });
    return { printer, ...listing, source: "live", cacheUpdatedAt: null };
  }

  await loadFilesCache();
  const cached = filesCacheEntry(printer);
  if (!refresh && filesCacheFresh(cached)) {
    return {
      printer,
      path: "/",
      files: cached.files || [],
      warnings: cached.warnings || [],
      source: "cache",
      cacheUpdatedAt: cached.updatedAt,
      cacheAgeSeconds: Math.max(0, Math.round((Date.now() - Date.parse(cached.updatedAt)) / 1000)),
      actionHints: printActionHints(printer)
    };
  }

  try {
    const fresh = await refreshPrinterFilesCache(printer);
    return {
      printer,
      path: "/",
      files: fresh.files || [],
      warnings: fresh.warnings || [],
      source: "live",
      cacheUpdatedAt: fresh.updatedAt,
      cacheAgeSeconds: 0,
      actionHints: printActionHints(printer)
    };
  } catch (error) {
    if (cached) {
      return {
        printer,
        path: "/",
        files: cached.files || [],
        warnings: [...(cached.warnings || []), `Live refresh failed: ${error?.message || error}`],
        source: "cache-stale",
        cacheUpdatedAt: cached.updatedAt,
        cacheAgeSeconds: Math.max(0, Math.round((Date.now() - Date.parse(cached.updatedAt)) / 1000)),
        actionHints: printActionHints(printer)
      };
    }
    throw error;
  }
}

async function resolvePrinter(reference) {
  const ref = String(reference ?? "").trim();
  if (!ref) throw new Error("printer_required");
  const printers = await listPrinters();
  const lower = ref.toLocaleLowerCase();
  const exact = printers.find((p) =>
    String(p.id) === ref ||
    String(p.serial_number || "").toLocaleLowerCase() === lower ||
    String(p.name || "").toLocaleLowerCase() === lower
  );
  if (exact) return exact;
  const partial = printers.filter((p) => String(p.name || "").toLocaleLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error("printer_reference_ambiguous");
  throw new Error("printer_not_found");
}

async function printerStatus(reference) {
  const printer = await resolvePrinter(reference);
  const status = await api(`/api/v1/printers/${printer.id}/status`);
  return { printer, status };
}

let openApiCache = null;
let openApiCacheAt = 0;
async function openApi() {
  if (openApiCache && Date.now() - openApiCacheAt < 5 * 60 * 1000) return openApiCache;
  openApiCache = await api("/openapi.json");
  openApiCacheAt = Date.now();
  return openApiCache;
}

async function searchOpenApi(query, limit = 20) {
  const doc = await openApi();
  const q = String(query || "").trim().toLocaleLowerCase();
  const rows = [];
  for (const [path, operations] of Object.entries(doc?.paths || {})) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const op = operations?.[method];
      if (!op) continue;
      const haystack = [path, op.summary, op.description, op.operationId, ...(op.tags || [])]
        .filter(Boolean).join(" ").toLocaleLowerCase();
      if (q && !haystack.includes(q)) continue;
      const params = (op.parameters || []).map((x) => ({
        name: x.name,
        in: x.in,
        required: Boolean(x.required),
        description: x.description || x.schema?.description || null
      }));
      rows.push({
        method: method.toUpperCase(),
        path,
        summary: op.summary || null,
        operationId: op.operationId || null,
        parameters: params,
        requestBody: op.requestBody?.content?.["application/json"]?.schema || null
      });
    }
  }
  return { query: q, count: rows.length, results: rows.slice(0, Math.max(1, Math.min(100, limit))) };
}

const speedModes = { silent: 1, standard: 2, sport: 3, ludicrous: 4 };

const tools = [
  {
    name: "bambuddy_health",
    description: "Check the local Bambuddy service used by SOL, authentication state, registered LAN printers, file cache and patch status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredScope: "read"
  },
  {
    name: "bambuddy_patch_status",
    description: "Inspect whether the local Bambuddy installation still contains SOL's Model Files fallback and direct SD print patches. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredScope: "read"
  },
  {
    name: "bambuddy_patch",
    description: "Reapply SOL's supported Bambuddy compatibility patches after a Bambuddy update. Creates a backup first and launches Windows UAC only when a patch is actually missing. Requires explicit user confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        confirmedByUser: { type: "boolean", description: "Optional compatibility flag. SOL enforces confirmation at sol_run_action." },
        force: { type: "boolean", default: true }
      },
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "bambuddy_list_printers",
    description: "List printers configured in Bambuddy. This is SOL's primary backend for LAN/Developer Mode Bambu printers.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredScope: "read"
  },
  {
    name: "bambuddy_printer_status",
    description: "Read live state, progress, layers, temperatures, Wi-Fi, AMS/external spool and print information from one Bambuddy printer.",
    inputSchema: {
      type: "object",
      properties: { printer: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["printer"],
      additionalProperties: false
    },
    requiredScope: "read"
  },
  {
    name: "bambuddy_fleet_status",
    description: "Read live status for every printer configured in Bambuddy.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredScope: "read"
  },
  {
    name: "bambuddy_files",
    description: "List files on a Bambuddy printer SD card. Root listings use a persistent cache for up to 24 hours; pass refresh=true when the user asks for current/live data, says 'ahora', 'en vivo' or requests a refresh. Non-root paths are always live.",
    inputSchema: {
      type: "object",
      properties: {
        printer: { type: "string", minLength: 1, maxLength: 160 },
        path: { type: "string", maxLength: 1000, default: "/" },
        refresh: { type: "boolean", default: false }
      },
      required: ["printer"],
      additionalProperties: false
    },
    requiredScope: "read"
  },
  {
    name: "bambuddy_materials",
    description: "Read AMS and external-spool material information for one Bambuddy printer.",
    inputSchema: {
      type: "object",
      properties: { printer: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["printer"],
      additionalProperties: false
    },
    requiredScope: "read"
  },
  {
    name: "bambuddy_queue",
    description: "List Bambuddy print queue items, optionally filtered by printer and status.",
    inputSchema: {
      type: "object",
      properties: {
        printer: { type: "string", maxLength: 160 },
        status: { type: "string", maxLength: 80 }
      },
      additionalProperties: false
    },
    requiredScope: "read"
  },
  {
    name: "bambuddy_openapi_search",
    description: "Search Bambuddy's live OpenAPI catalog to discover any supported endpoint and its parameters.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 240 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 }
      },
      additionalProperties: false
    },
    requiredScope: "read"
  },
  {
    name: "bambuddy_api_read",
    description: "Advanced read-only access to any Bambuddy GET endpoint under /api/v1/. Use bambuddy_openapi_search first when unsure.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 8, maxLength: 1000 },
        query: { type: "object", additionalProperties: true }
      },
      required: ["path"],
      additionalProperties: false
    },
    requiredScope: "read"
  },
  {
    name: "bambuddy_print_sd",
    description: "Start a 3MF that already exists in the root of a Bambuddy printer SD card, without re-uploading it. Requires explicit user confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        confirmedByUser: { type: "boolean", description: "Optional compatibility flag. SOL enforces confirmation at sol_run_action." },
        printer: { type: "string", minLength: 1, maxLength: 160 },
        file: { type: "string", minLength: 1, maxLength: 255 },
        plateId: { type: "integer", minimum: 1, maximum: 99, default: 1 },
        useAms: { type: "boolean", default: false },
        amsMapping: { type: "array", items: { type: "integer", minimum: -1, maximum: 255 } },
        bedLevelling: { type: "string", enum: ["off", "on", "auto"], default: "auto" },
        flowCali: { type: "string", enum: ["off", "on", "auto"], default: "auto" },
        vibrationCali: { type: "boolean", default: true },
        layerInspect: { type: "boolean", default: false },
        timelapse: { type: "boolean", default: false }
      },
      required: ["printer", "file"],
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "bambuddy_control",
    description: "Control one Bambuddy printer (pause, resume, stop, speed, temperature or light). Requires explicit user confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        confirmedByUser: { type: "boolean", description: "Optional compatibility flag. SOL enforces confirmation at sol_run_action." },
        printer: { type: "string", minLength: 1, maxLength: 160 },
        operation: { type: "string", enum: ["pause", "resume", "stop", "speed", "temperature", "light"] },
        speed: { type: "string", enum: ["silent", "standard", "sport", "ludicrous"] },
        component: { type: "string", enum: ["nozzle", "bed"] },
        temperatureC: { type: "integer", minimum: 0, maximum: 320 },
        nozzle: { type: "integer", minimum: 0, maximum: 1, default: 0 },
        on: { type: "boolean" }
      },
      required: ["printer", "operation"],
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "bambuddy_api_action",
    description: "Advanced full-control access to any Bambuddy POST/PUT/PATCH/DELETE endpoint under /api/v1/. Requires explicit user confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        confirmedByUser: { type: "boolean", description: "Optional compatibility flag. SOL enforces confirmation at sol_run_action." },
        method: { type: "string", enum: ["POST", "PUT", "PATCH", "DELETE"] },
        path: { type: "string", minLength: 8, maxLength: 1000 },
        query: { type: "object", additionalProperties: true },
        body: { type: "object", additionalProperties: true }
      },
      required: ["method", "path"],
      additionalProperties: false
    },
    requiredScope: "actions"
  }
];

function requireControl() {
  if (!config.allowControl) throw new Error("bambuddy_control_disabled");
}

function requireApiPath(path) {
  const value = String(path || "").trim();
  if (!value.startsWith("/api/v1/")) throw new Error("path_must_start_with_/api/v1/");
  return value;
}

async function dispatchTool(tool, args) {
  if (tool === "bambuddy_health") {
    const [auth, printers, , patchStatus] = await Promise.all([
      api("/api/v1/auth/status").catch((error) => ({ error: error.message })),
      listPrinters().catch(() => []),
      loadFilesCache(),
      inspectBambuddyPatches(config.bambuddyInstallDir, pluginDataDir).catch((error) => ({
        ok: false,
        complete: false,
        compatible: false,
        error: error?.message || String(error)
      }))
    ]);
    return {
      ok: !auth?.error,
      provider: "bambuddy",
      baseUrl: config.baseUrl,
      controlEnabled: config.allowControl,
      authentication: auth,
      printerCount: printers.length,
      filesCacheHours: config.filesCacheHours,
      filesCacheUpdatedAt: filesCache.updatedAt,
      cachedPrinterCount: Object.keys(filesCache.printers || {}).length,
      maintainPatches: config.maintainPatches,
      patchStatus
    };
  }
  if (tool === "bambuddy_patch_status") {
    return await inspectBambuddyPatches(config.bambuddyInstallDir, pluginDataDir);
  }
  if (tool === "bambuddy_patch") {
    requireControl();
    return await launchBambuddyPatch(config.bambuddyInstallDir, pluginDataDir, {
      force: args.force === undefined ? true : Boolean(args.force)
    });
  }
  if (tool === "bambuddy_list_printers") return { printers: await listPrinters() };
  if (tool === "bambuddy_printer_status") return await printerStatus(args.printer);
  if (tool === "bambuddy_fleet_status") {
    const printers = await listPrinters();
    const statuses = await Promise.all(printers.map(async (printer) => {
      try {
        const status = await api(`/api/v1/printers/${printer.id}/status`);
        return { printer, status };
      } catch (error) {
        return { printer, error: error?.message || String(error) };
      }
    }));
    return { printers: statuses };
  }
  if (tool === "bambuddy_files") {
    const printer = await resolvePrinter(args.printer);
    return await filesForPrinter(printer, {
      path: String(args.path || "/"),
      refresh: Boolean(args.refresh)
    });
  }
  if (tool === "bambuddy_materials") {
    const { printer, status } = await printerStatus(args.printer);
    return {
      printer,
      ams: status?.ams || [],
      externalSpool: status?.vt_tray || [],
      trayNow: status?.tray_now ?? null,
      amsMapping: status?.ams_mapping || [],
      amsExists: Boolean(status?.ams_exists)
    };
  }
  if (tool === "bambuddy_queue") {
    const query = {};
    if (args.printer) {
      const printer = await resolvePrinter(args.printer);
      query.printer_id = printer.id;
    }
    if (args.status) query.status = args.status;
    return { items: await api("/api/v1/queue/", { query }) };
  }
  if (tool === "bambuddy_openapi_search") {
    return await searchOpenApi(args.query || "", Number(args.limit || 20));
  }
  if (tool === "bambuddy_api_read") {
    return await api(requireApiPath(args.path), { method: "GET", query: args.query || {} });
  }

  if (tool === "bambuddy_print_sd") {
    requireControl(args);
    const printer = await resolvePrinter(args.printer);
    return await api(`/api/v1/printers/${printer.id}/print-sd`, {
      method: "POST",
      query: {
        filename: String(args.file || ""),
        plate_id: Number(args.plateId || 1),
        use_ams: Boolean(args.useAms),
        ams_mapping: Array.isArray(args.amsMapping) ? args.amsMapping : undefined,
        bed_levelling: String(args.bedLevelling || "auto"),
        flow_cali: String(args.flowCali || "auto"),
        vibration_cali: args.vibrationCali === undefined ? true : Boolean(args.vibrationCali),
        layer_inspect: Boolean(args.layerInspect),
        timelapse: Boolean(args.timelapse)
      }
    });
  }
  if (tool === "bambuddy_control") {
    requireControl(args);
    const printer = await resolvePrinter(args.printer);
    const op = String(args.operation || "").toLowerCase();
    if (["pause", "resume", "stop"].includes(op)) {
      return await api(`/api/v1/printers/${printer.id}/print/${op}`, { method: "POST" });
    }
    if (op === "speed") {
      const mode = speedModes[String(args.speed || "").toLowerCase()];
      if (!mode) throw new Error("speed_required");
      return await api(`/api/v1/printers/${printer.id}/print-speed`, {
        method: "POST",
        query: { mode }
      });
    }
    if (op === "temperature") {
      const component = String(args.component || "");
      const target = Number(args.temperatureC);
      const max = component === "nozzle" ? 320 : component === "bed" ? 140 : -1;
      if (!Number.isInteger(target) || target < 0 || target > max) throw new Error("invalid_temperature");
      const query = { target };
      if (component === "nozzle") query.nozzle = Number(args.nozzle || 0);
      return await api(`/api/v1/printers/${printer.id}/temperature/${component}`, {
        method: "POST",
        query
      });
    }
    if (op === "light") {
      if (typeof args.on !== "boolean") throw new Error("light_on_boolean_required");
      return await api(`/api/v1/printers/${printer.id}/chamber-light`, {
        method: "POST",
        query: { on: args.on }
      });
    }
    throw new Error("invalid_control_operation");
  }
  if (tool === "bambuddy_api_action") {
    requireControl(args);
    const method = String(args.method || "").toUpperCase();
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("invalid_http_method");
    return await api(requireApiPath(args.path), {
      method,
      query: args.query || {},
      body: args.body
    });
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
    console.warn(`SOL MCP tool registration failed: ${lastRegistrationError}`);
  }
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url || "/", "http://127.0.0.1").pathname;
  try {
    if (request.method === "GET" && path === "/health") {
      const health = await dispatchTool("bambuddy_health", {}).catch((error) => ({
        ok: false,
        error: error?.message || String(error)
      }));
      sendJson(response, health.ok ? 200 : 503, {
        ...health,
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
    const status = Number(error?.status)
      || (message.includes("disabled") || message.includes("confirmation_required") ? 403
        : message.includes("required") || message.includes("invalid") || message.includes("must_start") ? 400
          : 502);
    sendJson(response, status, { error: message });
  }
});

server.listen(config.apiPort, "127.0.0.1", async () => {
  console.log(JSON.stringify({
    type: "sol.plugin.ready",
    health: "healthy",
    details: {
      provider: "bambuddy",
      port: config.apiPort,
      controlEnabled: config.allowControl,
      filesCacheHours: config.filesCacheHours
    }
  }));
  await registerTools();
});

const retry = setInterval(() => {
  if (!toolsRegistered) void registerTools();
}, 15000);
retry.unref?.();

const initialPatchCheck = setTimeout(() => {
  if (!config.maintainPatches) return;
  void inspectBambuddyPatches(config.bambuddyInstallDir, pluginDataDir)
    .then(async (status) => {
      if (status.complete) {
        console.log(JSON.stringify({ type: "bambuddy.patch.check", status: "ok" }));
        return;
      }
      if (!status.compatible) {
        console.warn(`Bambuddy patch check found an incompatible installation: ${(status.issues || []).join(",")}`);
        return;
      }
      const result = await launchBambuddyPatch(config.bambuddyInstallDir, pluginDataDir, { force: false });
      console.log(JSON.stringify({ type: "bambuddy.patch.repair", reason: "startup", launched: result.launched, suppressed: result.suppressed || null }));
    })
    .catch((error) => console.warn(`Bambuddy patch startup check failed: ${error?.message || error}`));
}, 3500);
initialPatchCheck.unref?.();

const initialCacheRefresh = setTimeout(() => {
  void refreshAllFilesCache()
    .then((results) => console.log(JSON.stringify({ type: "bambuddy.files_cache.refresh", reason: "startup", results })))
    .catch((error) => console.warn(`Bambuddy files cache startup refresh failed: ${error?.message || error}`));
}, 5000);
initialCacheRefresh.unref?.();

const filesCacheRefresh = setInterval(() => {
  void refreshAllFilesCache()
    .then((results) => console.log(JSON.stringify({ type: "bambuddy.files_cache.refresh", reason: "daily", results })))
    .catch((error) => console.warn(`Bambuddy files cache daily refresh failed: ${error?.message || error}`));
}, 24 * 60 * 60 * 1000);
filesCacheRefresh.unref?.();

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(retry);
  clearTimeout(initialPatchCheck);
  clearTimeout(initialCacheRefresh);
  clearInterval(filesCacheRefresh);
  if (sol.enabled) await sol.registerMcpTools(callbackUrl, []).catch(() => undefined);
  server.close();
  console.log(`${signal}: stopping Bambuddy SOL plugin`);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));