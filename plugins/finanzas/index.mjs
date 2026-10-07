import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { SolPluginClientCore } from "./lib/sol-client-core.mjs";

function numberEnv(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value))) : fallback;
}

function cleanString(value, max = 500) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function normalizeDate(value, { required = false } = {}) {
  const text = cleanString(value, 32);
  if (!text) {
    if (required) throw new Error("dueDate_required");
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("invalid_date");
  const parsed = new Date(`${text}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) throw new Error("invalid_date");
  return text;
}

function normalizeAmount(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error("invalid_amount");
  return Math.round(number * 100) / 100;
}

function normalizeCurrency(value, fallback) {
  const text = (cleanString(value, 12) || fallback || "ARS").toUpperCase();
  if (!/^[A-Z]{3,6}$/.test(text)) throw new Error("invalid_currency");
  return text;
}

function parseReminderDays(value) {
  return [...new Set(String(value || "3,1")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 60))]
    .sort((a, b) => b - a);
}

function fingerprintFor(record) {
  const parts = [
    record.issuer?.toLowerCase() || "",
    record.concept?.toLowerCase() || "",
    record.period?.toLowerCase() || "",
    record.dueDate || "",
    record.amount === null || record.amount === undefined ? "" : String(record.amount),
    record.currency || ""
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
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
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 1024 * 1024) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const config = {
  apiPort: numberEnv("FINANZAS_SOL_API_PORT", 8782, 1024, 65535),
  defaultCurrency: normalizeCurrency(process.env.FINANZAS_DEFAULT_CURRENCY, "ARS"),
  archiveRoot: cleanString(process.env.FINANZAS_ARCHIVE_ROOT, 500) || "SOL/Finanzas",
  reminderDays: parseReminderDays(process.env.FINANZAS_REMINDER_DAYS)
};

const pluginDataDir = process.env.SOL_PLUGIN_DATA_DIR?.trim()
  || join(process.env.SOL_PLUGIN_ROOT?.trim() || process.cwd(), ".data");
const storePath = join(pluginDataDir, "finanzas.json");
const sol = new SolPluginClientCore();
const pluginId = process.env.SOL_PLUGIN_ID?.trim() || "finanzas";
const mcpPath = `/mcp/${randomBytes(24).toString("base64url")}`;
const callbackUrl = `http://127.0.0.1:${config.apiPort}${mcpPath}`;
let mutationQueue = Promise.resolve();

async function loadStore() {
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8"));
    return {
      version: 1,
      updatedAt: parsed.updatedAt || null,
      records: Array.isArray(parsed.records) ? parsed.records : []
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, updatedAt: null, records: [] };
    throw error;
  }
}

async function saveStore(store) {
  await mkdir(pluginDataDir, { recursive: true });
  store.updatedAt = new Date().toISOString();
  const tempPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(store, null, 2) + "\n";
  await writeFile(tempPath, payload, "utf8");
  try {
    await rename(tempPath, storePath);
  } catch {
    await writeFile(storePath, payload, "utf8");
  }
}

function mutate(fn) {
  const run = mutationQueue.then(async () => {
    const store = await loadStore();
    const result = await fn(store);
    await saveStore(store);
    return result;
  });
  mutationQueue = run.catch(() => undefined);
  return run;
}

function normalizeSource(source = {}) {
  return {
    kind: cleanString(source.kind, 40) || "gmail",
    gmailMessageId: cleanString(source.gmailMessageId, 200),
    gmailThreadId: cleanString(source.gmailThreadId, 200),
    subject: cleanString(source.subject, 500),
    from: cleanString(source.from, 500)
  };
}

function normalizeDocument(document = {}) {
  return {
    driveFileId: cleanString(document.driveFileId, 300),
    driveUrl: cleanString(document.driveUrl, 1200),
    fileName: cleanString(document.fileName, 500),
    mimeType: cleanString(document.mimeType, 120),
    archiveFolderId: cleanString(document.archiveFolderId, 300),
    archiveFolderPath: cleanString(document.archiveFolderPath, 800)
  };
}

function normalizeCalendar(calendar = {}) {
  return {
    eventId: cleanString(calendar.eventId, 300),
    eventUrl: cleanString(calendar.eventUrl, 1200),
    reminderDays: Array.isArray(calendar.reminderDays)
      ? [...new Set(calendar.reminderDays.map(Number).filter((item) => Number.isInteger(item) && item >= 0 && item <= 60))].sort((a, b) => b - a)
      : config.reminderDays
  };
}

function mergeObject(base, patch) {
  const result = { ...(base || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value !== null && value !== undefined && value !== "") result[key] = value;
  }
  return result;
}

function findRecord(store, { id, source, fingerprint }) {
  if (id) {
    const byId = store.records.find((item) => item.id === id);
    if (byId) return byId;
  }
  if (source?.gmailMessageId) {
    const byMessage = store.records.find((item) => item.source?.gmailMessageId === source.gmailMessageId);
    if (byMessage) return byMessage;
  }
  if (fingerprint) return store.records.find((item) => item.fingerprint === fingerprint) || null;
  return null;
}

function publicRecord(record) {
  return JSON.parse(JSON.stringify(record));
}

async function upsertDue(args) {
  const issuer = cleanString(args.issuer, 240);
  const concept = cleanString(args.concept, 500);
  if (!issuer) throw new Error("issuer_required");
  if (!concept) throw new Error("concept_required");

  const candidate = {
    issuer,
    concept,
    period: cleanString(args.period, 100),
    amount: normalizeAmount(args.amount),
    currency: normalizeCurrency(args.currency, config.defaultCurrency),
    dueDate: normalizeDate(args.dueDate, { required: true })
  };
  candidate.fingerprint = fingerprintFor(candidate);
  const source = normalizeSource(args.source);
  const document = normalizeDocument(args.document);
  const calendar = normalizeCalendar(args.calendar);
  const confidence = args.confidence === undefined ? null : Math.max(0, Math.min(1, Number(args.confidence)));
  if (confidence !== null && !Number.isFinite(confidence)) throw new Error("invalid_confidence");

  return await mutate(async (store) => {
    const existing = findRecord(store, { id: cleanString(args.id, 100), source, fingerprint: candidate.fingerprint });
    const now = new Date().toISOString();
    if (existing) {
      existing.issuer = candidate.issuer;
      existing.concept = candidate.concept;
      existing.period = candidate.period;
      existing.amount = candidate.amount;
      existing.currency = candidate.currency;
      existing.dueDate = candidate.dueDate;
      existing.fingerprint = candidate.fingerprint;
      existing.source = mergeObject(existing.source, source);
      existing.document = mergeObject(existing.document, document);
      existing.calendar = mergeObject(existing.calendar, calendar);
      if (confidence !== null) existing.confidence = confidence;
      const notes = cleanString(args.notes, 3000);
      if (notes) existing.notes = notes;
      if (existing.status !== "paid" && existing.status !== "dismissed" && existing.calendar?.eventId) existing.status = "scheduled";
      existing.updatedAt = now;
      return { created: false, record: publicRecord(existing) };
    }

    const status = calendar.eventId ? "scheduled" : "detected";
    const record = {
      id: randomUUID(),
      fingerprint: candidate.fingerprint,
      issuer: candidate.issuer,
      concept: candidate.concept,
      period: candidate.period,
      amount: candidate.amount,
      currency: candidate.currency,
      dueDate: candidate.dueDate,
      status,
      confidence,
      source,
      document,
      calendar,
      payment: null,
      notes: cleanString(args.notes, 3000),
      createdAt: now,
      updatedAt: now
    };
    store.records.push(record);
    return { created: true, record: publicRecord(record) };
  });
}

async function linkDue(args) {
  const id = cleanString(args.id, 100);
  if (!id) throw new Error("id_required");
  return await mutate(async (store) => {
    const record = store.records.find((item) => item.id === id);
    if (!record) throw new Error("vencimiento_not_found");
    record.source = mergeObject(record.source, normalizeSource(args.source));
    record.document = mergeObject(record.document, normalizeDocument(args.document));
    record.calendar = mergeObject(record.calendar, normalizeCalendar(args.calendar));
    if (record.status !== "paid" && record.status !== "dismissed" && record.calendar?.eventId) record.status = "scheduled";
    record.updatedAt = new Date().toISOString();
    return publicRecord(record);
  });
}

async function markPaid(args) {
  const id = cleanString(args.id, 100);
  if (!id) throw new Error("id_required");
  return await mutate(async (store) => {
    const record = store.records.find((item) => item.id === id);
    if (!record) throw new Error("vencimiento_not_found");
    record.status = "paid";
    record.payment = {
      paidAt: cleanString(args.paidAt, 64) || new Date().toISOString(),
      amount: args.amount === undefined ? record.amount : normalizeAmount(args.amount),
      proofDriveFileId: cleanString(args.proofDriveFileId, 300),
      proofDriveUrl: cleanString(args.proofDriveUrl, 1200),
      proofFileName: cleanString(args.proofFileName, 500),
      notes: cleanString(args.notes, 2000)
    };
    record.updatedAt = new Date().toISOString();
    return publicRecord(record);
  });
}

async function dismissDue(args) {
  const id = cleanString(args.id, 100);
  if (!id) throw new Error("id_required");
  return await mutate(async (store) => {
    const record = store.records.find((item) => item.id === id);
    if (!record) throw new Error("vencimiento_not_found");
    record.status = "dismissed";
    record.dismissedReason = cleanString(args.reason, 1000);
    record.updatedAt = new Date().toISOString();
    return publicRecord(record);
  });
}

async function listDue(args = {}) {
  const store = await loadStore();
  const status = cleanString(args.status, 40);
  const issuer = cleanString(args.issuer, 240)?.toLowerCase() || null;
  const fromDate = args.fromDate ? normalizeDate(args.fromDate) : null;
  const toDate = args.toDate ? normalizeDate(args.toDate) : null;
  const limit = Math.max(1, Math.min(200, Number(args.limit || 50)));
  return store.records
    .filter((item) => !status || item.status === status)
    .filter((item) => !issuer || String(item.issuer || "").toLowerCase().includes(issuer))
    .filter((item) => !fromDate || item.dueDate >= fromDate)
    .filter((item) => !toDate || item.dueDate <= toDate)
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)) || String(a.createdAt).localeCompare(String(b.createdAt)))
    .slice(0, limit)
    .map(publicRecord);
}

async function summary(args = {}) {
  const store = await loadStore();
  const fromDate = args.fromDate ? normalizeDate(args.fromDate) : null;
  const toDate = args.toDate ? normalizeDate(args.toDate) : null;
  const selected = store.records.filter((item) => (!fromDate || item.dueDate >= fromDate) && (!toDate || item.dueDate <= toDate));
  const counts = {};
  const totalsByCurrency = {};
  for (const item of selected) {
    counts[item.status] = (counts[item.status] || 0) + 1;
    if (item.status !== "dismissed" && item.amount !== null && item.amount !== undefined) {
      const currency = item.currency || config.defaultCurrency;
      totalsByCurrency[currency] = Math.round(((totalsByCurrency[currency] || 0) + Number(item.amount)) * 100) / 100;
    }
  }
  return { count: selected.length, counts, totalsByCurrency, fromDate, toDate };
}

const tools = [
  {
    name: "finanzas_status",
    description: "Read Finanzas plugin health, archive policy and persistent due-date counts.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredScope: "read"
  },
  {
    name: "finanzas_vencimientos_list",
    description: "List structured financial due dates stored by SOL, optionally filtered by status, issuer or date range.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["detected", "scheduled", "paid", "dismissed"] },
        issuer: { type: "string", maxLength: 240 },
        fromDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        toDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 }
      },
      additionalProperties: false
    },
    requiredScope: "read"
  },
  {
    name: "finanzas_vencimiento_get",
    description: "Read one structured financial due date by its Finanzas record id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1, maxLength: 100 } },
      required: ["id"],
      additionalProperties: false
    },
    requiredScope: "read"
  },
  {
    name: "finanzas_resumen",
    description: "Summarize due-date counts and amounts by currency for an optional date range.",
    inputSchema: {
      type: "object",
      properties: {
        fromDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        toDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }
      },
      additionalProperties: false
    },
    requiredScope: "read"
  },
  {
    name: "finanzas_vencimiento_upsert",
    description: "Create or update one detected bill/statement due date. Deduplicates first by Gmail message id and then by issuer/concept/period/due-date/amount fingerprint. Store metadata and external references only; keep documents in Drive. Requires standing or explicit user authorization.",
    inputSchema: {
      type: "object",
      properties: {
        confirmedByUser: { type: "boolean", const: true },
        id: { type: "string", maxLength: 100 },
        issuer: { type: "string", minLength: 1, maxLength: 240 },
        concept: { type: "string", minLength: 1, maxLength: 500 },
        period: { type: "string", maxLength: 100 },
        amount: { type: "number", minimum: 0 },
        currency: { type: "string", maxLength: 12 },
        dueDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        source: { type: "object", additionalProperties: false, properties: {
          kind: { type: "string", maxLength: 40 }, gmailMessageId: { type: "string", maxLength: 200 }, gmailThreadId: { type: "string", maxLength: 200 }, subject: { type: "string", maxLength: 500 }, from: { type: "string", maxLength: 500 }
        } },
        document: { type: "object", additionalProperties: false, properties: {
          driveFileId: { type: "string", maxLength: 300 }, driveUrl: { type: "string", maxLength: 1200 }, fileName: { type: "string", maxLength: 500 }, mimeType: { type: "string", maxLength: 120 }, archiveFolderId: { type: "string", maxLength: 300 }, archiveFolderPath: { type: "string", maxLength: 800 }
        } },
        calendar: { type: "object", additionalProperties: false, properties: {
          eventId: { type: "string", maxLength: 300 }, eventUrl: { type: "string", maxLength: 1200 }, reminderDays: { type: "array", maxItems: 10, items: { type: "integer", minimum: 0, maximum: 60 } }
        } },
        notes: { type: "string", maxLength: 3000 }
      },
      required: ["confirmedByUser", "issuer", "concept", "dueDate"],
      additionalProperties: false
    },
    requiredScope: "submit"
  },
  {
    name: "finanzas_vencimiento_link",
    description: "Attach or refresh Gmail, Drive and Calendar references for an existing due-date record. Requires standing or explicit user authorization.",
    inputSchema: {
      type: "object",
      properties: {
        confirmedByUser: { type: "boolean", const: true },
        id: { type: "string", minLength: 1, maxLength: 100 },
        source: { type: "object", additionalProperties: false, properties: {
          kind: { type: "string", maxLength: 40 }, gmailMessageId: { type: "string", maxLength: 200 }, gmailThreadId: { type: "string", maxLength: 200 }, subject: { type: "string", maxLength: 500 }, from: { type: "string", maxLength: 500 }
        } },
        document: { type: "object", additionalProperties: false, properties: {
          driveFileId: { type: "string", maxLength: 300 }, driveUrl: { type: "string", maxLength: 1200 }, fileName: { type: "string", maxLength: 500 }, mimeType: { type: "string", maxLength: 120 }, archiveFolderId: { type: "string", maxLength: 300 }, archiveFolderPath: { type: "string", maxLength: 800 }
        } },
        calendar: { type: "object", additionalProperties: false, properties: {
          eventId: { type: "string", maxLength: 300 }, eventUrl: { type: "string", maxLength: 1200 }, reminderDays: { type: "array", maxItems: 10, items: { type: "integer", minimum: 0, maximum: 60 } }
        } }
      },
      required: ["confirmedByUser", "id"],
      additionalProperties: false
    },
    requiredScope: "submit"
  },
  {
    name: "finanzas_vencimiento_marcar_pagado",
    description: "Mark a due date as paid and optionally link the payment proof stored in Drive. Requires explicit or standing user authorization.",
    inputSchema: {
      type: "object",
      properties: {
        confirmedByUser: { type: "boolean", const: true },
        id: { type: "string", minLength: 1, maxLength: 100 },
        paidAt: { type: "string", maxLength: 64 },
        amount: { type: "number", minimum: 0 },
        proofDriveFileId: { type: "string", maxLength: 300 },
        proofDriveUrl: { type: "string", maxLength: 1200 },
        proofFileName: { type: "string", maxLength: 500 },
        notes: { type: "string", maxLength: 2000 }
      },
      required: ["confirmedByUser", "id"],
      additionalProperties: false
    },
    requiredScope: "submit"
  },
  {
    name: "finanzas_vencimiento_descartar",
    description: "Dismiss a false positive or no-longer-relevant due date while retaining audit history. Requires explicit or standing user authorization.",
    inputSchema: {
      type: "object",
      properties: {
        confirmedByUser: { type: "boolean", const: true },
        id: { type: "string", minLength: 1, maxLength: 100 },
        reason: { type: "string", maxLength: 1000 }
      },
      required: ["confirmedByUser", "id"],
      additionalProperties: false
    },
    requiredScope: "submit"
  }
];

async function dispatchTool(tool, args = {}) {
  if (tool === "finanzas_status") {
    const store = await loadStore();
    const counts = store.records.reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {});
    return {
      ok: true,
      plugin: "finanzas",
      version: "0.1.0",
      records: store.records.length,
      counts,
      updatedAt: store.updatedAt,
      policy: {
        archiveRoot: config.archiveRoot,
        defaultCurrency: config.defaultCurrency,
        reminderDays: config.reminderDays,
        documentsStoredLocally: false,
        orchestration: "Gmail/Drive/Calendar are operated by the external SOL agent; this plugin stores structured state and references."
      }
    };
  }
  if (tool === "finanzas_vencimientos_list") return await listDue(args);
  if (tool === "finanzas_vencimiento_get") {
    const store = await loadStore();
    const record = store.records.find((item) => item.id === cleanString(args.id, 100));
    if (!record) throw new Error("vencimiento_not_found");
    return publicRecord(record);
  }
  if (tool === "finanzas_resumen") return await summary(args);
  if (tool === "finanzas_vencimiento_upsert") return await upsertDue(args);
  if (tool === "finanzas_vencimiento_link") return await linkDue(args);
  if (tool === "finanzas_vencimiento_marcar_pagado") return await markPaid(args);
  if (tool === "finanzas_vencimiento_descartar") return await dismissDue(args);
  throw new Error("tool_not_found");
}

let toolsRegistered = false;
let registeredToolNames = [];
let lastRegistrationError = null;

async function registerTools() {
  if (!sol.enabled) return;
  try {
    const registered = await sol.registerMcpTools(callbackUrl, tools);
    registeredToolNames = registered.map((item) => item.name);
    toolsRegistered = registeredToolNames.length === tools.length;
    lastRegistrationError = null;
  } catch (error) {
    toolsRegistered = false;
    lastRegistrationError = error?.message || String(error);
    console.warn(`Finanzas MCP tool registration failed: ${lastRegistrationError}`);
  }
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url || "/", "http://127.0.0.1").pathname;
  try {
    if (request.method === "GET" && path === "/health") {
      const status = await dispatchTool("finanzas_status", {});
      return sendJson(response, 200, {
        ...status,
        solEnabled: sol.enabled,
        toolsRegistered,
        registeredToolCount: registeredToolNames.length,
        registeredToolNames,
        registrationError: lastRegistrationError
      });
    }
    if (request.method !== "POST" || path !== mcpPath) return sendJson(response, 404, { error: "not_found" });
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
    return sendJson(response, 200, result);
  } catch (error) {
    const message = error?.message || String(error);
    const status = message.includes("not_found") ? 404
      : message.includes("required") || message.includes("invalid") ? 400
      : 502;
    return sendJson(response, status, { error: message });
  }
});

server.listen(config.apiPort, "127.0.0.1", async () => {
  await mkdir(pluginDataDir, { recursive: true }).catch(() => undefined);
  console.log(JSON.stringify({
    type: "sol.plugin.ready",
    health: "healthy",
    details: { provider: "finanzas", port: config.apiPort, storePath, archiveRoot: config.archiveRoot }
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
  if (sol.enabled) await sol.registerMcpTools(callbackUrl, []).catch(() => undefined);
  server.close();
  console.log(`${signal}: stopping Finanzas SOL plugin`);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
