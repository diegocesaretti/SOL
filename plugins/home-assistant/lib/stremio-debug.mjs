import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEBUG_TOOL_NAME = "home_assistant_stremio_debug_last";
const MAX_TRACE_EVENTS = 200;
const MAX_LOG_BYTES = 1024 * 1024;
const KEEP_LOG_LINES = 40;

function nowIso() {
  return new Date().toISOString();
}

function compactState(state) {
  if (!state || typeof state !== "object") return null;
  return {
    stremio: state.stremio ?? null,
    loading: state.loading ?? null,
    streamLike: state.streamLike ?? null,
    playerLike: state.playerLike ?? null,
    focusText: state.focusText ?? null,
    uiEventSequence: state.uiEventSequence ?? null
  };
}

function compactReadiness(readiness) {
  if (!readiness || typeof readiness !== "object") return null;
  return {
    ready: readiness.ready ?? null,
    alreadyPlaying: readiness.alreadyPlaying ?? false,
    via: readiness.via ?? null,
    waitedMs: readiness.waitedMs ?? null,
    state: compactState(readiness.state),
    note: readiness.note ?? null
  };
}

function compactVerification(verification) {
  if (!verification || typeof verification !== "object") return null;
  return {
    status: verification.status ?? null,
    confirmed: verification.confirmed ?? null,
    via: verification.via ?? null,
    waitedMs: verification.waitedMs ?? null,
    state: compactState(verification.state),
    reason: verification.reason ?? null,
    note: verification.note ?? null
  };
}

function compactObservation(observation) {
  if (!observation || typeof observation !== "object") return null;
  return {
    package: observation.package || observation.package_name || null,
    uiEventSequence: observation.ui_event_sequence ?? null,
    hasTree: Boolean(observation.tree || observation.root),
    focusText: observation.focus_hint?.text || observation.focused?.text || observation.focus_hint?.description || observation.focused?.description || null
  };
}

function compactAutoSelection(result) {
  if (!result || typeof result !== "object") return null;
  return {
    ok: result.ok === true,
    reason: result.reason ?? null,
    attempt: result.attempt ?? null,
    matchedText: result.matchedText ?? null,
    via: result.via ?? null,
    candidates: Array.isArray(result.candidates) ? result.candidates.slice(0, 8) : null,
    attempts: result.attempts ?? null,
    errors: Array.isArray(result.errors)
      ? result.errors.slice(-12).map((item) => ({ attempt: item.attempt ?? null, text: item.text ?? null, reason: item.reason ?? null }))
      : []
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
      seeders: result.selected.seeders ?? null
    } : null,
    directLookupError: result.directLookupError ?? null,
    selectorFallbackReason: result.selectorFallbackReason ?? null,
    playbackConfirmed: result.playbackConfirmed ?? null,
    firstStreamClick: result.firstStreamClick ? {
      ok: result.firstStreamClick.ok === true,
      commandSent: result.firstStreamClick.commandSent ?? null,
      reason: result.firstStreamClick.reason ?? null,
      readiness: compactReadiness(result.firstStreamClick.readiness),
      playbackVerification: compactVerification(result.firstStreamClick.playbackVerification)
    } : null,
    autoSelection: compactAutoSelection(result.autoSelection),
    playbackVerification: compactVerification(result.playbackVerification),
    launchGuard: result.launchGuard ? {
      ok: result.launchGuard.ok ?? null,
      retries: result.launchGuard.retries ?? null,
      finalStatus: result.launchGuard.finalStatus ?? null,
      finalPackage: result.launchGuard.finalPackage ?? null,
      allowStreamInput: result.launchGuard.allowStreamInput ?? null
    } : null
  };
}

function toolDefinition() {
  return {
    name: DEBUG_TOOL_NAME,
    description: "Return sanitized traces from recent Stremio play_best runs, including Android TV Satellite observation/click timing and selector failures. Never returns addon manifest URLs, tokens or direct stream URLs.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 20, default: 3 }
      },
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
  const originalObserve = proto.tvObserveRaw;
  const originalClickText = proto.tvClickText;
  const originalWaitForStreamUi = proto.waitForStreamUi;
  const originalVerifyPlayback = proto.verifyPlayback;
  const originalClickFirstStream = proto.clickFirstStream;
  const originalAutoSelect = proto.autoSelectVisualStream;

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

  proto.tvObserveRaw = async function tvObserveRawDebug(waitMs = 0) {
    const started = Date.now();
    const result = await originalObserve.call(this, waitMs);
    this.__stremioDebugEvent("tv_observe", {
      waitMs,
      elapsedMs: Date.now() - started,
      ok: Boolean(result),
      observation: compactObservation(result),
      diagnostic: result ? null : "observe_returned_null_http_json_or_timeout_hidden_by_legacy_path"
    });
    return result;
  };

  proto.tvClickText = async function tvClickTextDebug(text) {
    const started = Date.now();
    const result = await originalClickText.call(this, text);
    this.__stremioDebugEvent("click_text", {
      elapsedMs: Date.now() - started,
      text,
      ok: result?.ok === true,
      via: result?.via ?? null,
      status: result?.status ?? null,
      reason: result?.reason ?? null
    });
    return result;
  };

  proto.waitForStreamUi = async function waitForStreamUiDebug(...args) {
    const result = await originalWaitForStreamUi.apply(this, args);
    this.__stremioDebugEvent("wait_for_stream_ui", compactReadiness(result) || {});
    return result;
  };

  proto.verifyPlayback = async function verifyPlaybackDebug(...args) {
    const result = await originalVerifyPlayback.apply(this, args);
    this.__stremioDebugEvent("verify_playback", compactVerification(result) || {});
    return result;
  };

  proto.clickFirstStream = async function clickFirstStreamDebug(...args) {
    const result = await originalClickFirstStream.apply(this, args);
    const verification = result?.playbackVerification;
    const centerWasSent = result?.ok === true && result?.command === "DPAD_CENTER";
    const confirmed = verification?.confirmed === true;

    // Sending DPAD_CENTER is transport success, not proof that a stream was selected.
    // If playback remains unverified, allow play_best to continue into the visual matcher.
    const adjusted = centerWasSent && !confirmed
      ? {
          ...result,
          ok: false,
          commandSent: true,
          reason: "stremio_center_sent_but_playback_unverified"
        }
      : result;

    this.__stremioDebugEvent("click_first_stream", {
      ok: adjusted?.ok === true,
      commandSent: adjusted?.commandSent ?? centerWasSent,
      reason: adjusted?.reason ?? null,
      readiness: compactReadiness(adjusted?.readiness),
      playbackVerification: compactVerification(adjusted?.playbackVerification)
    });
    return adjusted;
  };

  proto.autoSelectVisualStream = async function autoSelectVisualStreamDebug(selected) {
    this.__stremioDebugEvent("visual_selector_start", {
      selected: selected ? {
        addonName: selected.addonName ?? null,
        name: selected.name ?? null,
        title: selected.title ?? null,
        quality: selected.quality ?? null
      } : null,
      configuredAttempts: this.stremioAutoSelectAttempts
    });
    const result = await originalAutoSelect.call(this, selected);
    this.__stremioDebugEvent("visual_selector_result", compactAutoSelection(result) || {});
    return result;
  };

  proto.handleStremioTool = async function handleStremioToolDebug(tool, args = {}) {
    if (tool === DEBUG_TOOL_NAME) {
      const limit = Math.max(1, Math.min(20, Number(args.limit) || 3));
      await this.__stremioDebugWriteQueue.catch(() => {});
      const traces = await readRecentTraces(this.__stremioDebugPath, limit);
      return {
        logFile: "stremio-debug.ndjson",
        storage: "SOL_PLUGIN_DATA_DIR",
        sanitized: true,
        traces
      };
    }

    if (tool !== "home_assistant_stremio_play_best") return originalHandle.call(this, tool, args);

    const previous = this.__stremioDebugContext;
    const trace = {
      schema: 1,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      startedAt: nowIso(),
      startedMs: Date.now(),
      request: {
        query: typeof args.query === "string" ? args.query.slice(0, 300) : null,
        id: args.id ?? null,
        mediaType: args.mediaType ?? null,
        year: args.year ?? null,
        season: args.season ?? null,
        episode: args.episode ?? null
      },
      config: {
        tvEnabled: Boolean(this.stremioTvEnabled),
        tvConfigured: Boolean(this.stremioTvUrl),
        tvTimeoutMs: this.stremioTvTimeoutMs,
        firstStreamDelayMs: this.stremioFirstStreamDelayMs,
        playbackVerifyMs: this.stremioPlaybackVerifyMs,
        visualAttempts: this.stremioAutoSelectAttempts,
        addonConfigured: Boolean(this.addonAggregator?.configured)
      },
      events: []
    };
    this.__stremioDebugContext = trace;
    this.__stremioDebugEvent("play_best_start");

    try {
      const result = await originalHandle.call(this, tool, args);
      trace.finishedAt = nowIso();
      trace.elapsedMs = Date.now() - trace.startedMs;
      trace.result = compactPlayResult(result);
      this.__stremioDebugEvent("play_best_result", trace.result || {});
      await this.__persistStremioDebugTrace(trace);
      return { ...result, debugTraceId: trace.id };
    } catch (error) {
      trace.finishedAt = nowIso();
      trace.elapsedMs = Date.now() - trace.startedMs;
      trace.error = error?.message || String(error);
      this.__stremioDebugEvent("play_best_error", { error: trace.error });
      await this.__persistStremioDebugTrace(trace);
      throw error;
    } finally {
      this.__stremioDebugContext = previous;
    }
  };

  return SolPluginClient;
}
