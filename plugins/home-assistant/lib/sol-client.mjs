import {
  STREMIO_MCP_TOOLS,
  SolPluginClient as CoreSolPluginClient
} from "./sol-client-core.mjs";
import { detailDeepLink } from "./stremio.mjs";
import { summarizeRankedStream } from "./stremio-addons.mjs";
import { installStremioAddonCompatibilityPatch } from "./stremio-addon-compat.mjs";

export { STREMIO_MCP_TOOLS };

function boolEnv(env, name, fallback = false) {
  const value = env[name];
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function numberEnv(env, name, fallback, min, max) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTvUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  let url;
  try { url = new URL(text); } catch { return ""; }
  if (url.protocol !== "http:") return "";
  return url.toString().replace(/\/$/, "");
}

function uniqueTextCandidates(selected) {
  const raw = [selected?.title, selected?.name, selected?.addonName]
    .filter((value) => typeof value === "string" && value.trim())
    .flatMap((value) => {
      const text = value.trim();
      const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
      return [text, firstLine];
    });
  const seen = new Set();
  const result = [];
  for (const value of raw) {
    const clean = value.replace(/\s+/g, " ").trim();
    if (clean.length < 3) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(clean.slice(0, 240));
  }
  return result;
}

async function responsePayload(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return await response.json().catch(() => ({}));
  return { text: (await response.text().catch(() => "")).slice(0, 500) };
}

function collectUiText(node, out = [], depth = 0) {
  if (!node || typeof node !== "object" || depth > 9 || out.length > 500) return out;
  for (const key of ["text", "description", "class", "view_id", "resource_id"]) {
    if (node[key]) out.push(String(node[key]));
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectUiText(child, out, depth + 1);
  }
  return out;
}

function classifyStremioObservation(observation) {
  const values = collectUiText(observation?.tree || observation?.root || null);
  const focus = observation?.focus_hint || observation?.focused || null;
  for (const key of ["text", "description", "class", "view_id"]) {
    if (focus?.[key]) values.push(String(focus[key]));
  }
  const text = values.join(" ").toLowerCase();
  const pkg = String(observation?.package || observation?.package_name || "").toLowerCase();
  const loading = /\b(loading|cargando|please wait|espere|progressbar|progress bar)\b/i.test(text);
  const streamLike = /\b(2160p?|1080p?|720p?|576p?|480p?|4k|uhd|remux|blu[ -]?ray|web[ ._-]?dl|webrip|torrent|seed(?:er)?s?|debrid|cached|\d+(?:[.,]\d+)?\s*(?:gib|gb|mib|mb))\b/i.test(text);
  const playerLike = /\b(pause|pausa|subtitles?|subt[ií]tulos|audio track|pista de audio|playback speed|velocidad de reproducci[oó]n)\b/i.test(text);
  const stremio = pkg.includes("stremio") || text.includes("stremio");
  return {
    stremio,
    loading,
    streamLike,
    playerLike,
    focusText: focus?.text || focus?.description || null,
    uiEventSequence: observation?.ui_event_sequence ?? null
  };
}

function safeSelection(selection) {
  return {
    selected: selection?.selected ? summarizeRankedStream(selection.selected, 0) : null,
    providerCount: Array.isArray(selection?.providers) ? selection.providers.length : 0,
    streamCount: Array.isArray(selection?.ranked) ? selection.ranked.length : 0,
    providers: Array.isArray(selection?.providers) ? selection.providers : [],
    errors: Array.isArray(selection?.errors) ? selection.errors : []
  };
}

export class SolPluginClient extends CoreSolPluginClient {
  constructor(env = process.env) {
    super(env);
    this.stremioAddonTimeoutMs = numberEnv(env, "HA_SOL_STREMIO_ADDON_TIMEOUT_MS", 20000, 1000, 120000);
    this.stremioAddonRetries = numberEnv(env, "HA_SOL_STREMIO_ADDON_RETRIES", 1, 0, 3);
    this.addonAggregator.timeoutMs = this.stremioAddonTimeoutMs;
    installStremioAddonCompatibilityPatch(this.addonAggregator, { retries: this.stremioAddonRetries });
    this.stremioAutoPlayFirstStream = boolEnv(env, "HA_SOL_STREMIO_AUTOPLAY_FIRST_STREAM", true);
    this.stremioFirstStreamDelayMs = numberEnv(env, "HA_SOL_STREMIO_FIRST_STREAM_DELAY_MS", 3500, 500, 15000);
    this.stremioAutoSelectStream = boolEnv(env, "HA_SOL_STREMIO_AUTOSELECT_STREAM", true);
    this.stremioTvEnabled = boolEnv(env, "HA_SOL_TV_ENABLED", false);
    this.stremioTvUrl = normalizeTvUrl(env.HA_SOL_TV_URL || "");
    this.stremioTvTimeoutMs = numberEnv(env, "HA_SOL_TV_TIMEOUT_MS", 8000, 1000, 30000);
    this.stremioAutoSelectAttempts = numberEnv(env, "HA_SOL_STREMIO_AUTOSELECT_ATTEMPTS", 6, 1, 12);
  }

  stremioStatus() {
    return {
      ...super.stremioStatus(),
      addonCompatibility: {
        protocolMode: "stream_bridge_compatible",
        requestTimeoutMs: this.stremioAddonTimeoutMs,
        retryCount: this.stremioAddonRetries,
        tolerantManifestFiltering: true,
        encodedEpisodeIds: true,
        rawColonFallback: true,
        preservesConfiguredManifestPath: true,
        preservesManifestQuery: true,
        directLookupGatesNativePlayback: false
      },
      firstStreamAutoPlay: {
        enabled: this.stremioAutoPlayFirstStream,
        configured: Boolean(this.stremioRemoteEntityId),
        delayMs: this.stremioFirstStreamDelayMs,
        transport: "Home Assistant remote.send_command DPAD_CENTER",
        readiness: this.stremioTvEnabled && this.stremioTvUrl
          ? "Android TV Satellite waits for the stream list before sending OK"
          : "fixed fallback delay"
      },
      visualAutoSelect: {
        enabled: this.stremioAutoSelectStream,
        configured: this.stremioTvEnabled && Boolean(this.stremioTvUrl),
        attempts: this.stremioAutoSelectAttempts,
        transport: "Android TV Satellite click_text",
        role: "fallback_only"
      }
    };
  }

  async tvObserveRaw(waitMs = 0) {
    if (!this.stremioTvEnabled || !this.stremioTvUrl) return null;
    const url = new URL(`${this.stremioTvUrl}/observe`);
    if (waitMs > 0) url.searchParams.set("wait_ms", String(Math.min(1500, Math.max(0, Math.trunc(waitMs)))));
    try {
      const response = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(Math.max(this.stremioTvTimeoutMs, waitMs + 1500))
      });
      if (!response.ok) return null;
      return await response.json().catch(() => null);
    } catch {
      return null;
    }
  }

  async waitForStreamUi() {
    if (!this.stremioTvEnabled || !this.stremioTvUrl) {
      await sleep(this.stremioFirstStreamDelayMs);
      return { ready: true, via: "fixed_delay", waitedMs: this.stremioFirstStreamDelayMs };
    }

    const started = Date.now();
    const timeoutMs = Math.max(this.stremioFirstStreamDelayMs, 6500);
    let last = null;
    await sleep(500);

    while (Date.now() - started < timeoutMs) {
      const observation = await this.tvObserveRaw(650);
      if (observation) {
        last = classifyStremioObservation(observation);
        if (last.playerLike) {
          return { ready: false, alreadyPlaying: true, via: "tv_satellite", waitedMs: Date.now() - started, state: last };
        }
        if (last.stremio && !last.loading && last.streamLike) {
          return { ready: true, via: "tv_satellite", waitedMs: Date.now() - started, state: last };
        }
      }
      await sleep(250);
    }

    return {
      ready: true,
      via: "tv_satellite_timeout_fallback",
      waitedMs: Date.now() - started,
      state: last,
      note: "Accessibility did not expose an unmistakable stream row; sending one OK after the bounded wait."
    };
  }

  async clickFirstStream() {
    if (!this.stremioAutoPlayFirstStream) return { ok: false, reason: "stremio_first_stream_autoplay_disabled" };
    if (!this.stremioRemoteEntityId) return { ok: false, reason: "stremio_remote_entity_id_required" };

    const readiness = await this.waitForStreamUi();
    if (readiness.alreadyPlaying) {
      return {
        ok: true,
        skipped: true,
        reason: "stremio_player_already_visible",
        readiness
      };
    }

    try {
      const result = await this.haService("remote", "send_command", {
        entity_id: this.stremioRemoteEntityId,
        command: "DPAD_CENTER"
      });
      return {
        ok: true,
        via: "home_assistant_remote",
        service: "remote.send_command",
        remoteEntityId: this.stremioRemoteEntityId,
        command: "DPAD_CENTER",
        readiness,
        result
      };
    } catch (error) {
      return {
        ok: false,
        reason: error?.message || String(error),
        readiness
      };
    }
  }

  async tvClickText(text) {
    if (!this.stremioTvEnabled || !this.stremioTvUrl) {
      return { ok: false, reason: "tv_satellite_not_configured" };
    }

    const executeResponse = await fetch(`${this.stremioTvUrl}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actions: [{ action: "click_text", text }],
        session_id: "stremio-auto-select",
        screenshot: false,
        quiet_ms: 160,
        wait_timeout_ms: 1600,
        gap_ms: 60
      }),
      signal: AbortSignal.timeout(Math.max(this.stremioTvTimeoutMs, 5000))
    }).catch(() => null);

    if (executeResponse) {
      const payload = await responsePayload(executeResponse);
      const first = Array.isArray(payload?.actions) ? payload.actions[0] : null;
      if (executeResponse.ok && (first?.ok === true || (payload?.ok === true && first?.ok !== false))) {
        return { ok: true, via: "execute", text };
      }
      if (![404, 405].includes(executeResponse.status)) {
        return {
          ok: false,
          via: "execute",
          text,
          status: executeResponse.status,
          reason: first?.error || payload?.error || "text_not_clicked"
        };
      }
    }

    const legacyResponse = await fetch(`${this.stremioTvUrl}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "click_text", text }),
      signal: AbortSignal.timeout(this.stremioTvTimeoutMs)
    }).catch(() => null);
    if (!legacyResponse) return { ok: false, via: "legacy", text, reason: "tv_satellite_unreachable" };
    const payload = await responsePayload(legacyResponse);
    if (legacyResponse.ok && payload?.ok !== false) return { ok: true, via: "legacy", text };
    return {
      ok: false,
      via: "legacy",
      text,
      status: legacyResponse.status,
      reason: payload?.error || "text_not_clicked"
    };
  }

  async autoSelectVisualStream(selected) {
    if (!this.stremioAutoSelectStream) return { ok: false, reason: "stremio_visual_autoselect_disabled" };
    if (!this.stremioTvEnabled || !this.stremioTvUrl) return { ok: false, reason: "tv_satellite_not_configured" };

    const candidates = uniqueTextCandidates(selected);
    if (!candidates.length) return { ok: false, reason: "stremio_selected_stream_has_no_clickable_label" };

    const errors = [];
    for (let attempt = 1; attempt <= this.stremioAutoSelectAttempts; attempt += 1) {
      await sleep(attempt === 1 ? 850 : Math.min(1200, 350 + attempt * 130));
      for (const text of candidates) {
        const result = await this.tvClickText(text);
        if (result.ok) {
          return {
            ok: true,
            attempt,
            matchedText: text,
            via: result.via,
            candidatesTried: candidates.length
          };
        }
        errors.push({ attempt, text, reason: result.reason || "not_clicked" });
      }
    }

    return {
      ok: false,
      reason: "stremio_selected_stream_not_found_in_visible_ui",
      candidates,
      attempts: this.stremioAutoSelectAttempts,
      errors: errors.slice(-8)
    };
  }

  async handleStremioTool(tool, args = {}) {
    if (tool !== "home_assistant_stremio_play_best") return super.handleStremioTool(tool, args);
    if (!this.stremioEnabled) throw new Error("stremio_deep_links_disabled");

    const autoPlay = args.autoPlay === undefined ? this.stremioAutoPlayDefault : Boolean(args.autoPlay);
    const { resolved, streamId } = await this.resolveForStream(args);
    const preferences = this.streamPreferences(args);

    let selection = { selected: null, ranked: [], errors: [], providers: [] };
    let directLookupError = null;
    if (this.stremioAddonConfigError) {
      directLookupError = this.stremioAddonConfigError;
    } else if (this.addonAggregator.configured) {
      try {
        selection = await this.addonAggregator.selectStream(resolved.type, streamId, preferences);
      } catch (error) {
        directLookupError = error?.message || String(error);
      }
    } else {
      directLookupError = "stremio_addon_manifests_not_configured";
    }

    const summary = safeSelection(selection);
    const content = {
      type: resolved.type,
      id: resolved.id,
      videoId: resolved.videoId,
      selected: resolved.selected
    };
    const useProxy = args.useSelectorProxy === undefined ? this.stremioProxyUseForPlay : Boolean(args.useSelectorProxy);

    if (useProxy && selection.selected) {
      if (this.stremioProxyConfigError) throw new Error(this.stremioProxyConfigError);
      await this.selectorProxy.ensureStarted();
      const proxySelection = this.selectorProxy.buildSelectionDeepLink({
        type: resolved.type,
        id: resolved.id,
        season: resolved.season,
        episode: resolved.episode,
        preferences,
        autoPlay
      });
      return {
        content,
        preferences,
        ...summary,
        deliveryMode: "selector_proxy_exact",
        proxy: { manifestUrl: this.selectorProxy.manifestUrl(), sessionId: proxySelection.sessionId },
        launch: await this.launchStremio(proxySelection.deepLink)
      };
    }

    const nativeLink = detailDeepLink({
      type: content.type,
      id: content.id,
      videoId: content.videoId || content.id,
      autoPlay: true
    });
    const launch = await this.launchStremio(nativeLink);
    const firstStreamClick = await this.clickFirstStream();
    const nativeFallback = {
      used: !selection.selected,
      reason: !selection.selected
        ? (directLookupError || (summary.errors[0]?.error ?? "stremio_direct_addon_lookup_empty"))
        : null,
      note: !selection.selected
        ? "Direct SOL addon lookup returned no selectable stream, so playback continued through Stremio's own installed-addon stream list."
        : null
    };

    if (firstStreamClick.ok) {
      return {
        content,
        preferences,
        ...summary,
        directLookupError,
        nativeFallback,
        selectorFallbackReason: useProxy && !selection.selected ? "stremio_no_direct_stream_for_selector" : null,
        launch,
        deliveryMode: firstStreamClick.skipped ? "stremio_autoplay_started" : "first_stream_center_click",
        firstStreamClick,
        playbackRequested: true
      };
    }

    const autoSelection = selection.selected
      ? await this.autoSelectVisualStream(summary.selected)
      : { ok: false, reason: "no_direct_stream_label_for_visual_match" };

    if (autoSelection.ok) {
      return {
        content,
        preferences,
        ...summary,
        directLookupError,
        nativeFallback,
        launch,
        deliveryMode: "visual_selection_automatic_fallback",
        firstStreamClick,
        autoSelection,
        playbackRequested: true
      };
    }

    return {
      content,
      preferences,
      ...summary,
      directLookupError,
      nativeFallback,
      launch,
      deliveryMode: "stremio_native_stream_list_unconfirmed",
      firstStreamClick,
      autoSelection,
      playbackRequested: true,
      visualSelectionHint: {
        addonName: summary.selected?.addonName || null,
        name: summary.selected?.name || null,
        title: summary.selected?.title || null,
        quality: summary.selected?.quality || null,
        languages: summary.selected?.languages || [],
        instruction: selection.selected
          ? "Stremio is open with its native stream list. The automatic OK was not confirmed; inspect the current focus before another keypress."
          : "The direct addon query returned no streams, but Stremio was opened anyway so its installed addons can load normally. Inspect the native stream list before another keypress."
      }
    };
  }
}