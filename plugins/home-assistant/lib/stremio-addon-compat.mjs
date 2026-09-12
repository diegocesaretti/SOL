import { addonSupportsStream } from "./stremio-addons.mjs";
import {
  STREMIO_MCP_TOOLS as CORE_STREMIO_MCP_TOOLS,
  SolPluginClient as CoreSolPluginClient
} from "./sol-client-core.mjs";

const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
const SIZE_RE = /(?<!\d)(\d+(?:[.,]\d+)?)\s*(TiB|TB|GiB|GB|MiB|MB)\b/i;
const REMOVED_PROXY_TOOLS = new Set([
  "home_assistant_stremio_proxy_status",
  "home_assistant_stremio_proxy_install"
]);

function applyNativeOnlyPolicy() {
  // Legacy proxy environment values are intentionally ignored from 0.3.13 onward.
  process.env.HA_SOL_STREMIO_PROXY_ENABLED = "false";
  process.env.HA_SOL_STREMIO_PROXY_USE_FOR_PLAY = "false";

  for (let index = CORE_STREMIO_MCP_TOOLS.length - 1; index >= 0; index -= 1) {
    if (REMOVED_PROXY_TOOLS.has(CORE_STREMIO_MCP_TOOLS[index]?.name)) {
      CORE_STREMIO_MCP_TOOLS.splice(index, 1);
    }
  }

  const playBest = CORE_STREMIO_MCP_TOOLS.find((tool) => tool?.name === "home_assistant_stremio_play_best");
  if (playBest) {
    playBest.description = "Resolve content, optionally query/rank configured Stremio addons for a best-effort visible match, then use the normal Play Store Stremio UI for playback. No public HTTPS selector proxy or SOL addon installation is required.";
    if (playBest.inputSchema?.properties) delete playBest.inputSchema.properties.useSelectorProxy;
  }

  const statusTool = CORE_STREMIO_MCP_TOOLS.find((tool) => tool?.name === "home_assistant_stremio_status");
  if (statusTool) {
    statusTool.description = "Report Stremio deep-link, addon aggregation, native playback and Android TV Satellite readiness.";
  }

  if (!CoreSolPluginClient.prototype.__solNativeOnlyStatusPatched) {
    const originalStatus = CoreSolPluginClient.prototype.stremioStatus;
    CoreSolPluginClient.prototype.stremioStatus = function stremioStatusNativeOnly() {
      const status = originalStatus.call(this);
      const { selectorProxy: _selectorProxy, ...rest } = status;
      const capabilities = { ...(rest.capabilities || {}) };
      delete capabilities.exactSelectedStreamViaProxy;
      return {
        ...rest,
        playbackMode: "native_stremio_only",
        capabilities: {
          ...capabilities,
          nativeInstalledAddonPlayback: true,
          bestEffortVisualRankedSelection: true,
          publicHttpsSelectorRequired: false
        },
        limitations: [
          "Official Stremio deep links cannot directly carry an exact stream/provider/quality.",
          "When Android TV Satellite can match the ranked stream text, SOL may select it visually; otherwise playback falls back to the first native Stremio stream.",
          "Pause/play/volume/seek remain Home Assistant media/remote controls, not Stremio deep-link commands."
        ]
      };
    };
    CoreSolPluginClient.prototype.__solNativeOnlyStatusPatched = true;
  }
}

applyNativeOnlyPolicy();

function clean(value) {
  return String(value ?? "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function declaredResources(manifest) {
  const resources = Array.isArray(manifest?.resources) ? manifest.resources : [];
  return resources.map((resource) => typeof resource === "string" ? { name: resource } : resource)
    .filter((resource) => resource && typeof resource === "object" && typeof resource.name === "string");
}

function declaresStream(manifest) {
  return declaredResources(manifest).some((resource) => resource.name === "stream");
}

function streamKey(stream) {
  if (typeof stream?.infoHash === "string" && stream.infoHash) {
    return `torrent:${stream.infoHash.toLowerCase()}:${Number(stream.fileIdx ?? -1)}`;
  }
  if (typeof stream?.url === "string" && stream.url) return `url:${stream.url}`;
  if (typeof stream?.externalUrl === "string" && stream.externalUrl) return `external:${stream.externalUrl}`;
  if (typeof stream?.ytId === "string" && stream.ytId) return `youtube:${stream.ytId}`;
  return `text:${[stream?.name, stream?.title, stream?.description].map((value) => String(value || "")).join("|")}`;
}

function streamSizeGb(stream) {
  const videoSize = stream?.behaviorHints?.videoSize;
  if (typeof videoSize === "number" && Number.isFinite(videoSize) && videoSize > 0) {
    return videoSize / (1024 ** 3);
  }
  const text = [stream?.name, stream?.title, stream?.description, stream?.behaviorHints?.filename]
    .filter(Boolean).join("\n");
  const match = text.match(SIZE_RE);
  if (!match) return null;
  const value = Number(match[1].replace(",", "."));
  if (!Number.isFinite(value)) return null;
  const unit = match[2].toLowerCase();
  if (unit === "tib" || unit === "tb") return value * 1024;
  if (unit === "mib" || unit === "mb") return value / 1024;
  return value;
}

function profileMode(manifestUrl) {
  try {
    const url = new URL(manifestUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const marker = parts.at(-1) === "manifest.json" ? parts.at(-2) || "" : "";
    if (marker.startsWith("D-")) return "anonymous_config";
    if (marker.startsWith("U-")) return "user_profile";
    return "public_or_path_config";
  } catch {
    return "unknown";
  }
}

function resourceUrl(manifestUrl, mediaType, mediaId, { rawColons = false } = {}) {
  const url = new URL(manifestUrl);
  const marker = "/manifest.json";
  if (!url.pathname.endsWith(marker)) throw new Error("stremio_addon_manifest_path_invalid");
  const basePath = url.pathname.slice(0, -marker.length);
  const type = encodeURIComponent(String(mediaType));
  let id = encodeURIComponent(String(mediaId));
  if (rawColons) id = id.replace(/%3A/gi, ":");
  url.pathname = `${basePath}/stream/${type}/${id}.json`;
  url.hash = "";
  return url.toString();
}

function requestError(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "stremio_addon_timeout";
  return error?.message || String(error);
}

async function fetchStreamsOnce(url, timeoutMs) {
  const started = Date.now();
  let response;
  try {
    response = await fetch(url, {
      headers: {
        accept: "application/json, text/plain;q=0.9, */*;q=0.1",
        "user-agent": "SOL-Stremio-Bridge/1"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    return {
      ok: false,
      transient: true,
      elapsedMs: Date.now() - started,
      error: requestError(error)
    };
  }

  const status = response.status;
  const elapsedMs = Date.now() - started;
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    return {
      ok: false,
      transient: TRANSIENT_HTTP.has(status),
      status,
      elapsedMs,
      error: `stremio_addon_http_${status}`
    };
  }

  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    return { ok: false, transient: false, status, elapsedMs, error: "stremio_addon_invalid_json" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, transient: false, status, elapsedMs, error: "stremio_addon_invalid_json" };
  }
  if (!Array.isArray(payload.streams)) {
    return { ok: false, transient: false, status, elapsedMs, error: "stremio_addon_streams_invalid" };
  }

  return {
    ok: true,
    transient: false,
    status,
    elapsedMs,
    streams: payload.streams.filter((stream) => stream && typeof stream === "object" && !Array.isArray(stream))
  };
}

async function fetchStreams(url, timeoutMs, retries = 1) {
  const attempts = [];
  for (let retry = 0; retry <= retries; retry += 1) {
    const result = await fetchStreamsOnce(url, timeoutMs);
    attempts.push(result);
    if (result.ok || !result.transient || retry >= retries) return { ...result, networkAttempts: attempts.length };
    await sleep(Math.min(800, 200 * (retry + 1)));
  }
  return { ok: false, error: "stremio_addon_request_failed", networkAttempts: attempts.length };
}

function safeAttempt(variant, result) {
  return {
    variant,
    ok: Boolean(result.ok),
    status: result.status ?? null,
    elapsedMs: result.elapsedMs ?? null,
    networkAttempts: result.networkAttempts || 1,
    count: result.ok ? result.streams.length : 0,
    error: result.ok ? null : result.error || "stremio_addon_request_failed"
  };
}

async function requestProvider(addon, mediaType, mediaId, timeoutMs, retries = 1) {
  const manifestCompatible = addonSupportsStream(addon.manifest, mediaType, mediaId);
  const attempts = [];
  const variants = [{ rawColons: false, label: "encoded_id" }];
  if (String(mediaId).includes(":")) variants.push({ rawColons: true, label: "raw_colons_fallback" });

  let firstError = null;
  for (const variant of variants) {
    const url = resourceUrl(addon.manifestUrl, mediaType, mediaId, variant);
    const result = await fetchStreams(url, timeoutMs, retries);
    attempts.push(safeAttempt(variant.label, result));
    if (result.ok && result.streams.length > 0) {
      return {
        streams: result.streams,
        manifestCompatible,
        profileMode: profileMode(addon.manifestUrl),
        attempts,
        error: null
      };
    }
    if (!result.ok) firstError ||= result.error;
  }

  return {
    streams: [],
    manifestCompatible,
    profileMode: profileMode(addon.manifestUrl),
    attempts,
    error: firstError
  };
}

export function installStremioAddonCompatibilityPatch(aggregator, { retries = 1 } = {}) {
  if (!aggregator || aggregator.__solCompatPatched) return aggregator;
  aggregator.__solCompatPatched = true;
  aggregator.addonRetries = Math.max(0, Math.min(3, Number(retries) || 0));

  const originalStatus = aggregator.status.bind(aggregator);
  const originalRankStreams = aggregator.rankStreams.bind(aggregator);

  aggregator.status = async function statusCompat(options = {}) {
    const status = await originalStatus(options);
    return {
      ...status,
      requestTimeoutMs: this.timeoutMs,
      retryCount: this.addonRetries,
      protocolMode: "stream_bridge_compatible",
      addons: (status.addons || []).map((item, index) => ({
        ...item,
        profileMode: this.addons[index] ? profileMode(this.addons[index].manifestUrl) : "unknown"
      }))
    };
  };

  aggregator.getStreams = async function getStreamsCompat(mediaType, mediaId, { provider = null } = {}) {
    await this.refresh();
    const providerKey = clean(provider).toLowerCase();
    const candidates = this.addons.filter((addon) =>
      declaresStream(addon.manifest)
      && (!providerKey || addon.name.toLowerCase().includes(providerKey) || addon.id.toLowerCase().includes(providerKey))
    );

    const results = await Promise.allSettled(candidates.map((addon) => requestProvider(
      addon,
      mediaType,
      mediaId,
      this.timeoutMs,
      this.addonRetries
    )));

    const merged = [];
    const errors = [];
    const providers = [];
    const seen = new Set();

    results.forEach((result, addonIndex) => {
      const addon = candidates[addonIndex];
      if (result.status === "rejected") {
        const message = requestError(result.reason);
        errors.push({ addonName: addon.name, error: message });
        providers.push({
          id: addon.id,
          name: addon.name,
          version: addon.version,
          profileMode: profileMode(addon.manifestUrl),
          manifestCompatible: null,
          streamCount: 0,
          attempts: []
        });
        return;
      }

      const diagnostic = result.value;
      providers.push({
        id: addon.id,
        name: addon.name,
        version: addon.version,
        profileMode: diagnostic.profileMode,
        manifestCompatible: diagnostic.manifestCompatible,
        streamCount: diagnostic.streams.length,
        attempts: diagnostic.attempts
      });

      if (!diagnostic.streams.length) {
        errors.push({
          addonName: addon.name,
          error: diagnostic.error || "stremio_addon_zero_streams",
          profileMode: diagnostic.profileMode,
          manifestCompatible: diagnostic.manifestCompatible,
          attempts: diagnostic.attempts
        });
      }

      diagnostic.streams.forEach((stream, providerIndex) => {
        const key = streamKey(stream);
        if (seen.has(key)) return;
        seen.add(key);
        merged.push({ addon, stream, providerIndex });
      });
    });

    return { streams: merged, errors, providers };
  };

  aggregator.rankStreams = async function rankStreamsCompat(mediaType, mediaId, preferences = {}) {
    const result = await originalRankStreams(mediaType, mediaId, preferences);
    const maxSizeGb = Number(preferences.maxSizeGb || 0);
    const ranked = result.ranked
      .map((entry) => {
        const sizeGb = streamSizeGb(entry.stream);
        return sizeGb === null ? entry : { ...entry, details: { ...entry.details, sizeGb } };
      })
      .filter((entry) => !(Number.isFinite(maxSizeGb) && maxSizeGb > 0 && entry.details.sizeGb !== null && entry.details.sizeGb > maxSizeGb))
      .sort((a, b) => b.score - a.score || (b.details.seeders || 0) - (a.details.seeders || 0) || ((a.details.sizeGb ?? Infinity) - (b.details.sizeGb ?? Infinity)));
    return { ...result, ranked };
  };

  return aggregator;
}

export const __test = {
  resourceUrl,
  requestProvider,
  declaresStream,
  profileMode,
  fetchStreamsOnce,
  streamKey,
  streamSizeGb
};