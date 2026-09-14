import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEBUG_TOOL_NAME = "home_assistant_stremio_debug_last";
const MAX_TRACE_EVENTS = 120;
const MAX_LOG_BYTES = 1024 * 1024;
const KEEP_LOG_LINES = 40;

function nowIso() {
  return new Date().toISOString();
}

function compactReadiness(readiness) {
  if (!readiness || typeof readiness !== "object") return null;
  return {
    ready: readiness.ready ?? null,
    via: readiness.via ?? null,
    waitedMs: readiness.waitedMs ?? null,
    openToKeysDelayMs: readiness.openToKeysDelayMs ?? null,
    reason: readiness.reason ?? null
  };
}

function compactClick(click) {
  if (!click || typeof click !== "object") return null;
  return {
    ok: click.ok === true,
    commandSent: click.commandSent ?? null,
    reason: click.reason ?? null,
    via: click.via ?? null,
    commands: Array.isArray(click.commands) ? click.commands : null,
    targetIndex: click.targetIndex ?? click.indexedSelection?.index ?? null,
    initialFocusIndex: click.initialFocusIndex ?? null,
    requestedRights: click.requestedRights ?? null,
    forwardedRights: click.forwardedRights ?? null,
    suppressedRights: click.suppressedRights ?? null,
    injectedLefts: click.injectedLefts ?? null,
    keyDelayMs: click.keyDelayMs ?? null,
    centerDelayMs: click.centerDelayMs ?? null,
    centerSent: click.centerSent ?? null,
    readiness: compactReadiness(click.readiness)
  };
}

function compactPlayResult(result) {
  if (!result || typeof result !== "object") return null;
  return {
    deliveryMode: result.deliveryMode ?? null,
    providerCount: result.providerCount ?? null,
    streamCount: result.streamCount ?? null,
    selected: result.selected ? {
      addonName: result.selected.addonName ?? null,
      name: result.selected.name ?? null,
      title: result.selected.title ?? null,
      quality: result.selected.quality ?? null,
      codec: result.selected.codec ?? null,
      sizeGb: result.selected.sizeGb ?? null,
      seeders: result.selected.seeders ?? null,
      nativeIndex: result.selected.nativeIndex ?? null
    } : null,
    directLookupError: result.directLookupError ?? null,
    playbackConfirmed: result.playbackConfirmed ?? null,
    firstStreamClick: compactClick(result.firstStreamClick),
    indexedSelection: result.indexedSelection ? {
      ok: result.indexedSelection.ok ?? null,
      index: result.indexedSelection.index ?? null,
      reason: result.indexedSelection.reason ?? null,
      confidence: result.indexedSelection.confidence ?? null
    } : null,
    accountWideLanguageSelection: result.accountWideLanguageSelection ? {
      ok: result.accountWideLanguageSelection.ok ?? null,
      language: result.accountWideLanguageSelection.language ?? null,
      nativeIndex: result.accountWideLanguageSelection.nativeIndex ?? null,
      reason: result.accountWideLanguageSelection.reason ?? null,
      failClosed: result.accountWideLanguageSelection.failClosed ?? null
    } : null,
    launchGuard: result.launchGuard ? {
      ok: result.launchGuard.ok ?? null,
      mode: result.launchGuard.mode ?? null,
      allowStreamInput: result.launchGuard.allowStreamInput ?? null,
      wake: result.launchGuard.wake ?? null
    } : null
  };
}

function toolDefinition() {
  return {
    name: DEBUG_TOOL_NAME,
    description: "Return sanitized traces from recent Stremio playback runs, including indexed navigation, delays and CENTER delivery. Never returns addon URLs, tokens or direct stream URLs.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 20, default: 3 } },
      additionalProperties: false
    },
    requiredScope: "read"
  };
}

async function readRecentTraces(path, limit) {
  try {
    const text = await readFile(path, "utf8");
    return text.split(/\r?\n/).filter(Boolean).slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch { return { malformed: true }; }
    });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    return [{ readError: error?.message || String(error) }];
  }
}

async function rotateIfNeeded(path) {
  try {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) <= MAX_LOG_BYTES) return;
    const lines = text.split(/\r?\n/).filter(Boolean).slice(-KEEP_LOG_LINES);
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  } catch {
    // Debug rotation must never interfere with playback.
  }
}

export function installStremioDebugging(SolPluginClient, STREMIO_MCP_TOOLS) {
  const proto = SolPluginClient?.prototype;
  if (!proto || proto.__stremioDebugInstalled) return SolPluginClient;
  proto.__stremioDebugInstalled = true;

  if (Array.isArray(STREMIO_MCP_TOOLS) && !STREMIO_MCP_TOOLS.some((tool) => tool?.name === DEBUG_TOOL_NAME)) {
    STREMIO_MCP_TOOLS.push(toolDefinition());
  }

  const originalHandle = proto.handleStremioTool;
  const originalWaitForStreamUi = proto.waitForStreamUi;
  const originalClickFirstStream = proto.clickFirstStream;

  proto.__stremioDebugPath = join(process.env.SOL_PLUGIN_DATA_DIR || new URL("../.data", import.meta.url).pathname, "stremio-debug.ndjson");
  proto.__stremioDebugWriteQueue = Promise.resolve();

  proto.__stremioDebugEvent = function stremioDebugEvent(stage, data = {}) {
    const trace = this.__stremioDebugContext;
    if (!trace || trace.events.length >= MAX_TRACE_EVENTS) return;
    trace.events.push({ at: nowIso(), ms: Date.now() - trace.startedMs, stage, ...data });
  };

  proto.__persistStremioDebugTrace = function persistStremioDebugTrace(trace) {
    const line = `${JSON.stringify(trace)}\n`;
    this.__stremioDebugWriteQueue = this.__stremioDebugWriteQueue
      .then(() => appendFile(this.__stremioDebugPath, line, "utf8"))
      .then(() => rotateIfNeeded(this.__stremioDebugPath))
      .catch((error) => console.warn(`Stremio debug trace write failed: ${error?.message || error}`));
    return this.__stremioDebugWriteQueue;
  };

  proto.waitForStreamUi = async function waitForStreamUiDebug(...args) {
    const result = await originalWaitForStreamUi.apply(this, args);
    this.__stremioDebugEvent("wait_for_stream_ui", compactReadiness(result) || {});
    return result;
  };

  proto.clickFirstStream = async function clickFirstStreamDebug(...args) {
    const result = await originalClickFirstStream.apply(this, args);
    this.__stremioDebugEvent("click_first_stream", compactClick(result) || {});
    return result;
  };

  proto.handleStremioTool = async function handleStremioToolDebug(tool, args = {}) {
    if (tool === DEBUG_TOOL_NAME) {
      const limit = Math.max(1, Math.min(20, Number(args.limit) || 3));
      await this.__stremioDebugWriteQueue.catch(() => {});
      return {
        logFile: "stremio-debug.ndjson",
        storage: "SOL_PLUGIN_DATA_DIR",
        sanitized: true,
        traces: await readRecentTraces(this.__stremioDebugPath, limit)
      };
    }

    const playbackTool = tool === "home_assistant_stremio_play_best" || tool === "home_assistant_stremio_play";
    if (!playbackTool) return originalHandle.call(this, tool, args);

    const previous = this.__stremioDebugContext;
    const trace = {
      schema: 2,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      startedAt: nowIso(),
      startedMs: Date.now(),
      request: {
        query: typeof args.query === "string" ? args.query.slice(0, 300) : null,
        id: args.id ?? null,
        mediaType: args.mediaType ?? null,
        season: args.season ?? null,
        episode: args.episode ?? null,
        language: args.language ?? null,
        profile: args.profile ?? null
      },
      config: {
        firstStreamDelayMs: this.stremioFirstStreamDelayMs,
        addonConfigured: Boolean(this.addonAggregator?.configured),
        haOnlyTvControl: true
      },
      events: []
    };
    this.__stremioDebugContext = trace;
    this.__stremioDebugEvent("play_start");

    try {
      const result = await originalHandle.call(this, tool, args);
      trace.finishedAt = nowIso();
      trace.elapsedMs = Date.now() - trace.startedMs;
      trace.result = compactPlayResult(result);
      this.__stremioDebugEvent("play_result", trace.result || {});
      await this.__persistStremioDebugTrace(trace);
      return { ...result, debugTraceId: trace.id };
    } catch (error) {
      trace.finishedAt = nowIso();
      trace.elapsedMs = Date.now() - trace.startedMs;
      trace.error = error?.message || String(error);
      this.__stremioDebugEvent("play_error", { error: trace.error });
      await this.__persistStremioDebugTrace(trace);
      throw error;
    } finally {
      this.__stremioDebugContext = previous;
    }
  };

  return SolPluginClient;
}
