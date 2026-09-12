import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import {
  CinemetaClient,
  STREMIO_DEEP_LINK_CAPABILITIES,
  addonDeepLink,
  boardDeepLink,
  detailDeepLink,
  discoverCatalogDeepLink,
  discoverDeepLink,
  isStremioDeepLink,
  libraryDeepLink,
  searchDeepLink
} from "./stremio.mjs";
import {
  StremioAddonAggregator,
  parseAddonManifestList,
  summarizeRankedStream
} from "./stremio-addons.mjs";
import { StremioSelectorProxy } from "./stremio-proxy.mjs";

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

function numberSetting(env, name, fallback = 0) {
  const value = Number(env[name] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

async function readRequestBody(request, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

const STREAM_PREFERENCE_PROPERTIES = {
  quality: { type: "string", enum: ["auto", "4k", "1080p", "720p", "480p"], description: "Preferred video resolution." },
  language: { type: "string", enum: ["any", "latin", "spanish", "english"], description: "Preferred audio/release language inferred from stream labels." },
  codec: { type: "string", enum: ["any", "h264", "h265", "av1"], description: "Preferred codec inferred from stream labels." },
  maxSizeGb: { type: "number", minimum: 0, maximum: 500, description: "Soft maximum stream size in GiB; 0 means unlimited." },
  provider: { type: "string", minLength: 1, maxLength: 120, description: "Optional addon name/id filter." },
  preferHdr: { type: "boolean" },
  preferDolbyVision: { type: "boolean" }
};

const CONTENT_RESOLVE_PROPERTIES = {
  query: { type: "string", minLength: 1, maxLength: 300 },
  id: { type: "string", minLength: 1, maxLength: 300 },
  mediaType: { type: "string", enum: ["auto", "movie", "series"], default: "auto" },
  year: { type: "integer", minimum: 1880, maximum: 2200 },
  season: { type: "integer", minimum: 0, maximum: 10000 },
  episode: { type: "integer", minimum: 0, maximum: 10000 }
};

const STREMIO_ACTION_SUFFIX = " Uses Home Assistant Android TV Remote remote.turn_on(activity=stremio://...) against the standard Play Store Stremio app; it does not modify or replace Stremio. A direct human request to open/play Stremio content authorizes this launch action. Home Assistant remains responsible for pause/play/volume/seek transport controls.";

export const STREMIO_MCP_TOOLS = [
  {
    name: "home_assistant_stremio_status",
    description: "Report Stremio deep-link, addon aggregation and optional SOL Stream Selector proxy status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredScope: "read"
  },
  {
    name: "home_assistant_stremio_search",
    description: "Search Cinemeta by natural title and return ranked movie/series candidates with IMDb ids. Does not launch the TV.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 300 },
        mediaType: { type: "string", enum: ["auto", "movie", "series"], default: "auto" },
        year: { type: "integer", minimum: 1880, maximum: 2200 },
        limit: { type: "integer", minimum: 1, maximum: 25, default: 10 }
      },
      required: ["query"],
      additionalProperties: false
    },
    requiredScope: "read"
  },
  {
    name: "home_assistant_stremio_resolve",
    description: "Resolve a movie/series title or IMDb id to an official Stremio detail deep link. For series, season+episode resolves the exact videoId. Does not launch the TV.",
    inputSchema: {
      type: "object",
      properties: { ...CONTENT_RESOLVE_PROPERTIES, autoPlay: { type: "boolean" } },
      additionalProperties: false
    },
    requiredScope: "read"
  },
  {
    name: "home_assistant_stremio_addons",
    description: "Refresh and list the configured Stremio addon manifests that can be queried by SOL. Manifest URLs are kept secret and are not returned.",
    inputSchema: {
      type: "object",
      properties: { refresh: { type: "boolean", default: false } },
      additionalProperties: false
    },
    requiredScope: "read"
  },
  {
    name: "home_assistant_stremio_streams",
    description: "Resolve a movie or exact series episode, query every compatible configured Stremio addon, deduplicate and rank streams. Returns safe summaries only, never direct stream URLs or configured addon URLs.",
    inputSchema: {
      type: "object",
      properties: { ...CONTENT_RESOLVE_PROPERTIES, ...STREAM_PREFERENCE_PROPERTIES, limit: { type: "integer", minimum: 1, maximum: 30, default: 10 } },
      additionalProperties: false
    },
    requiredScope: "read"
  },
  {
    name: "home_assistant_stremio_select_stream",
    description: "Resolve content and select the highest-ranked stream from configured Stremio addons using quality/language/codec/size/provider preferences. Returns a safe summary without exposing stream credentials.",
    inputSchema: {
      type: "object",
      properties: { ...CONTENT_RESOLVE_PROPERTIES, ...STREAM_PREFERENCE_PROPERTIES },
      additionalProperties: false
    },
    requiredScope: "read"
  },
  {
    name: "home_assistant_stremio_proxy_status",
    description: "Report the optional SOL Stream Selector addon proxy state. Exact injection into standard Stremio requires this proxy to be exposed through trusted HTTPS and installed in Stremio.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredScope: "read"
  },
  {
    name: "home_assistant_stremio_proxy_install",
    description: "Open the Stremio install prompt for the SOL Stream Selector addon. Requires the selector proxy public HTTPS origin/token to be configured and reachable." + STREMIO_ACTION_SUFFIX,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredScope: "actions"
  },
  {
    name: "home_assistant_stremio_play_best",
    description: "Resolve content, query configured Stremio addons and rank/select the best stream. When the HTTPS SOL Stream Selector proxy is enabled for playback, Stremio receives exactly that selected stream; otherwise it opens the normal detail page without autoplay and returns a visual-selection hint for Android TV Satellite." + STREMIO_ACTION_SUFFIX,
    inputSchema: {
      type: "object",
      properties: { ...CONTENT_RESOLVE_PROPERTIES, ...STREAM_PREFERENCE_PROPERTIES, autoPlay: { type: "boolean" }, useSelectorProxy: { type: "boolean", description: "Override configured exact selector proxy use for this request." } },
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "home_assistant_stremio_open_page",
    description: "Open the standard Stremio Board, Discover or Library page on Android TV." + STREMIO_ACTION_SUFFIX,
    inputSchema: {
      type: "object",
      properties: { page: { type: "string", enum: ["board", "discover", "library"] } },
      required: ["page"],
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "home_assistant_stremio_open_search",
    description: "Open the standard Stremio search page with a pre-filled query." + STREMIO_ACTION_SUFFIX,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1, maxLength: 300 } },
      required: ["query"],
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "home_assistant_stremio_open_detail",
    description: "Open a Stremio detail page by exact type/id/videoId, optionally requesting Android TV autoPlay." + STREMIO_ACTION_SUFFIX,
    inputSchema: {
      type: "object",
      properties: {
        mediaType: { type: "string", enum: ["movie", "series", "channel", "tv"] },
        id: { type: "string", minLength: 1, maxLength: 300 },
        videoId: { type: "string", minLength: 1, maxLength: 300 },
        autoPlay: { type: "boolean" }
      },
      required: ["mediaType", "id"],
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "home_assistant_stremio_play",
    description: "Resolve a movie or exact series episode from a natural title/IMDb id, build the official Stremio deep link and launch it on Android TV. This legacy path does not select an exact addon stream; prefer home_assistant_stremio_play_best when addons are configured." + STREMIO_ACTION_SUFFIX,
    inputSchema: {
      type: "object",
      properties: { ...CONTENT_RESOLVE_PROPERTIES, autoPlay: { type: "boolean" } },
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "home_assistant_stremio_adjacent_episode",
    description: "Resolve and launch the next or previous episode of a Cinemeta series from the current season/episode." + STREMIO_ACTION_SUFFIX,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 300 },
        id: { type: "string", minLength: 1, maxLength: 300 },
        year: { type: "integer", minimum: 1880, maximum: 2200 },
        currentSeason: { type: "integer", minimum: 0, maximum: 10000 },
        currentEpisode: { type: "integer", minimum: 0, maximum: 10000 },
        direction: { type: "string", enum: ["next", "previous"], default: "next" },
        autoPlay: { type: "boolean" }
      },
      required: ["currentSeason", "currentEpisode"],
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "home_assistant_stremio_open_catalog",
    description: "Open a specific Stremio addon catalog in Discover, optionally filtered by genre." + STREMIO_ACTION_SUFFIX,
    inputSchema: {
      type: "object",
      properties: {
        manifestUrl: { type: "string", minLength: 1, maxLength: 2000 },
        mediaType: { type: "string", enum: ["movie", "series", "channel", "tv"] },
        catalogId: { type: "string", minLength: 1, maxLength: 300 },
        genre: { type: "string", minLength: 1, maxLength: 300 }
      },
      required: ["manifestUrl", "mediaType", "catalogId"],
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "home_assistant_stremio_open_addon",
    description: "Open/install an addon manifest through Stremio's documented stremio:// addon deep-link format." + STREMIO_ACTION_SUFFIX,
    inputSchema: {
      type: "object",
      properties: { manifestUrl: { type: "string", minLength: 1, maxLength: 2000 } },
      required: ["manifestUrl"],
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "home_assistant_stremio_open_deep_link",
    description: "Advanced escape hatch: open an already-built URI only when it uses the stremio:// scheme." + STREMIO_ACTION_SUFFIX,
    inputSchema: {
      type: "object",
      properties: { uri: { type: "string", minLength: 10, maxLength: 4000 } },
      required: ["uri"],
      additionalProperties: false
    },
    requiredScope: "actions"
  }
];

export class SolPluginClient {
  constructor(env = process.env) {
    this.env = env;
    this.baseUrl = (env.SOL_PLUGIN_API_URL || env.SOL_CORE_URL || "").trim().replace(/\/$/, "");
    this.token = env.SOL_PLUGIN_TOKEN?.trim() || "";
    this.enabled = Boolean(this.baseUrl && this.token);
    this.inputId = null;

    this.stremioEnabled = boolEnv(env, "HA_SOL_STREMIO_ENABLED", true);
    this.stremioRemoteEntityId = (env.HA_SOL_STREMIO_REMOTE_ENTITY_ID || env.HA_SOL_TV_REMOTE_ENTITY_ID || "").trim();
    this.stremioTimeoutMs = numberEnv(env, "HA_SOL_STREMIO_TIMEOUT_MS", 8000, 1000, 30000);
    this.stremioAutoPlayDefault = boolEnv(env, "HA_SOL_STREMIO_AUTOPLAY", true);
    this.allowControl = boolEnv(env, "HA_SOL_ALLOW_CONTROL", false);
    this.haUrl = (env.HA_URL || "").trim().replace(/\/$/, "");
    this.haToken = (env.HA_TOKEN || "").trim();
    this.cinemeta = new CinemetaClient({ timeoutMs: this.stremioTimeoutMs });

    this.stremioAddonConfigError = null;
    let addonManifests = [];
    try { addonManifests = parseAddonManifestList(env.HA_SOL_STREMIO_ADDONS || ""); }
    catch (error) { this.stremioAddonConfigError = error?.message || String(error); }
    this.stremioDefaultPreferences = {
      quality: (env.HA_SOL_STREMIO_DEFAULT_QUALITY || "1080p").trim().toLowerCase(),
      language: (env.HA_SOL_STREMIO_DEFAULT_LANGUAGE || "any").trim().toLowerCase(),
      codec: (env.HA_SOL_STREMIO_DEFAULT_CODEC || "any").trim().toLowerCase(),
      maxSizeGb: Math.max(0, numberSetting(env, "HA_SOL_STREMIO_MAX_SIZE_GB", 0)),
      preferHdr: boolEnv(env, "HA_SOL_STREMIO_PREFER_HDR", false),
      preferDolbyVision: boolEnv(env, "HA_SOL_STREMIO_PREFER_DV", false)
    };
    this.addonAggregator = new StremioAddonAggregator({ manifestUrls: addonManifests, timeoutMs: this.stremioTimeoutMs });

    this.stremioProxyConfigError = null;
    try {
      this.selectorProxy = new StremioSelectorProxy({
        aggregator: this.addonAggregator,
        cinemeta: this.cinemeta,
        enabled: boolEnv(env, "HA_SOL_STREMIO_PROXY_ENABLED", false),
        port: numberEnv(env, "HA_SOL_STREMIO_PROXY_PORT", 8770, 1024, 65535),
        publicUrl: env.HA_SOL_STREMIO_PROXY_PUBLIC_URL || "",
        token: env.HA_SOL_STREMIO_PROXY_TOKEN || ""
      });
    } catch (error) {
      this.stremioProxyConfigError = error?.message || String(error);
      this.selectorProxy = new StremioSelectorProxy({ aggregator: this.addonAggregator, cinemeta: this.cinemeta, enabled: false });
    }
    this.stremioProxyUseForPlay = boolEnv(env, "HA_SOL_STREMIO_PROXY_USE_FOR_PLAY", false);

    this.mcpProxyServer = null;
    this.mcpProxyUrl = "";
    this.mcpProxyTarget = "";
    this.mcpProxyPath = `/mcp-proxy/${randomBytes(24).toString("base64url")}`;
  }

  async request(path, { method = "POST", body } = {}) {
    if (!this.enabled) throw new Error("SOL plugin runtime API is unavailable");
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || `SOL Plugin API HTTP ${response.status}`);
    return payload;
  }

  async ensureInput(baseUrl) {
    if (this.inputId) return this.inputId;
    const result = await this.request("/v1/plugin-api/inputs/register", {
      body: {
        provider: "home_assistant",
        externalAccountId: baseUrl,
        label: "Home Assistant"
      }
    });
    this.inputId = result.input.id;
    return this.inputId;
  }

  async setInputStatus(baseUrl, status, lastSyncAt) {
    if (!this.enabled) return;
    const inputId = await this.ensureInput(baseUrl);
    await this.request(`/v1/plugin-api/inputs/${inputId}/status`, {
      body: { status, ...(lastSyncAt ? { lastSyncAt } : {}) }
    });
  }

  async ingestPresence(baseUrl, entity) {
    if (!this.enabled) return;
    const inputId = await this.ensureInput(baseUrl);
    await this.request(`/v1/plugin-api/inputs/${inputId}/items`, {
      body: {
        externalId: `${entity.entity_id}:${entity.last_updated || Date.now()}`,
        kind: "sensor_event",
        occurredAt: entity.last_updated || new Date().toISOString(),
        observedAt: new Date().toISOString(),
        title: entity.attributes?.friendly_name || entity.entity_id,
        text: `${entity.attributes?.friendly_name || entity.entity_id} is ${entity.state}`,
        origin: "home_assistant",
        metadata: {
          eventType: "presence",
          entityId: entity.entity_id,
          state: entity.state,
          latitude: entity.attributes?.latitude,
          longitude: entity.attributes?.longitude,
          source: entity.attributes?.source,
          gpsAccuracy: entity.attributes?.gps_accuracy
        }
      }
    });
  }

  async upsertPerson({ entityId, label, metadata, autoLinkMember }) {
    if (!this.enabled) return null;
    const result = await this.request("/v1/plugin-api/identities/person", {
      body: { externalId: entityId, label, metadata, autoLinkMember }
    });
    return result.person || null;
  }

  streamPreferences(args = {}) {
    return {
      quality: args.quality || this.stremioDefaultPreferences.quality,
      language: args.language || this.stremioDefaultPreferences.language,
      codec: args.codec || this.stremioDefaultPreferences.codec,
      maxSizeGb: args.maxSizeGb === undefined ? this.stremioDefaultPreferences.maxSizeGb : Number(args.maxSizeGb),
      provider: args.provider || null,
      preferHdr: args.preferHdr === undefined ? this.stremioDefaultPreferences.preferHdr : Boolean(args.preferHdr),
      preferDolbyVision: args.preferDolbyVision === undefined ? this.stremioDefaultPreferences.preferDolbyVision : Boolean(args.preferDolbyVision)
    };
  }

  async resolveForStream(args = {}) {
    if (!args.query && !args.id) throw new Error("stremio_query_or_id_required");
    const resolved = await this.cinemeta.resolve({
      query: args.query,
      id: args.id,
      mediaType: args.mediaType || "auto",
      year: args.year,
      season: args.season,
      episode: args.episode,
      autoPlay: false
    });
    if (resolved.type === "series" && !resolved.videoId) throw new Error("stremio_exact_episode_required_for_stream_selection");
    return { resolved, streamId: resolved.videoId || resolved.id };
  }

  stremioStatus() {
    return {
      enabled: this.stremioEnabled,
      remoteEntityId: this.stremioRemoteEntityId || null,
      remoteConfigured: Boolean(this.stremioRemoteEntityId),
      standardPlayStoreCompatible: true,
      modifiesStremioApp: false,
      launchTransport: "Home Assistant Android TV Remote: remote.turn_on(activity=<stremio:// deep link>)",
      metadataProvider: "Cinemeta",
      cinemetaBaseUrl: "https://v3-cinemeta.strem.io",
      autoPlayDefault: this.stremioAutoPlayDefault,
      addonAggregation: {
        configured: this.addonAggregator.configured,
        configuredCount: this.addonAggregator.manifestUrls.length,
        configError: this.stremioAddonConfigError,
        defaults: this.stremioDefaultPreferences
      },
      selectorProxy: {
        ...this.selectorProxy.status(),
        useForPlay: this.stremioProxyUseForPlay,
        configError: this.stremioProxyConfigError
      },
      capabilities: {
        ...STREMIO_DEEP_LINK_CAPABILITIES,
        addonManifestDiscovery: true,
        addonStreamAggregation: true,
        addonStreamRanking: true,
        exactSelectedStreamViaProxy: this.selectorProxy.readyForInstall
      },
      limitations: [
        "Official Stremio deep links cannot directly carry an exact stream/provider/quality.",
        "Without the SOL Stream Selector HTTPS proxy, exact selection falls back to visual selection in the normal Stremio stream list.",
        "Remote Stremio addons must be served over trusted HTTPS; 127.0.0.1 is the documented exception but points to the TV itself on Android TV.",
        "Pause/play/volume/seek remain Home Assistant media/remote controls, not Stremio deep-link commands."
      ]
    };
  }

  async haService(domain, service, data = {}) {
    if (!this.haUrl || !this.haToken) throw new Error("home_assistant_credentials_unavailable");
    const response = await fetch(`${this.haUrl}/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.haToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(this.stremioTimeoutMs)
    });
    const payload = await response.json().catch(async () => ({ text: await response.text().catch(() => "") }));
    if (!response.ok) throw new Error(`home_assistant_service_http_${response.status}`);
    return payload;
  }

  async launchStremio(uri) {
    if (!this.stremioEnabled) throw new Error("stremio_deep_links_disabled");
    if (!this.allowControl) throw new Error("home_assistant_control_disabled");
    if (!this.stremioRemoteEntityId) throw new Error("stremio_remote_entity_id_required");
    if (!isStremioDeepLink(uri)) throw new Error("stremio_deep_link_invalid_scheme");
    const result = await this.haService("remote", "turn_on", {
      entity_id: this.stremioRemoteEntityId,
      activity: uri
    });
    return {
      ok: true,
      via: "home_assistant_androidtv_remote",
      service: "remote.turn_on",
      remoteEntityId: this.stremioRemoteEntityId,
      deepLink: uri,
      result,
      verificationHint: "If Android TV Satellite is configured, use home_assistant_tv_observe after launch when visual confirmation matters."
    };
  }

  async handleStremioTool(tool, args = {}) {
    if (!this.stremioEnabled) throw new Error("stremio_deep_links_disabled");
    const autoPlay = args.autoPlay === undefined ? this.stremioAutoPlayDefault : Boolean(args.autoPlay);

    if (tool === "home_assistant_stremio_status") {
      return {
        ...this.stremioStatus(),
        addons: this.stremioAddonConfigError ? null : await this.addonAggregator.status().catch((error) => ({ error: error?.message || String(error) }))
      };
    }
    if (tool === "home_assistant_stremio_search") {
      return {
        query: String(args.query || ""),
        results: await this.cinemeta.search(args.query, {
          mediaType: args.mediaType || "auto",
          year: args.year,
          limit: args.limit || 10
        })
      };
    }
    if (tool === "home_assistant_stremio_resolve") {
      if (!args.query && !args.id) throw new Error("stremio_query_or_id_required");
      return this.cinemeta.resolve({
        query: args.query,
        id: args.id,
        mediaType: args.mediaType || "auto",
        year: args.year,
        season: args.season,
        episode: args.episode,
        autoPlay
      });
    }
    if (tool === "home_assistant_stremio_addons") {
      if (this.stremioAddonConfigError) throw new Error(this.stremioAddonConfigError);
      return this.addonAggregator.status({ refresh: Boolean(args.refresh) });
    }
    if (tool === "home_assistant_stremio_streams" || tool === "home_assistant_stremio_select_stream") {
      if (this.stremioAddonConfigError) throw new Error(this.stremioAddonConfigError);
      if (!this.addonAggregator.configured) throw new Error("stremio_addon_manifests_required");
      const { resolved, streamId } = await this.resolveForStream(args);
      const preferences = this.streamPreferences(args);
      const selection = await this.addonAggregator.selectStream(resolved.type, streamId, preferences);
      if (tool === "home_assistant_stremio_select_stream") {
        return {
          content: { type: resolved.type, id: resolved.id, videoId: resolved.videoId, selected: resolved.selected },
          preferences,
          selected: selection.selected ? summarizeRankedStream(selection.selected, 0) : null,
          providerCount: selection.providers.length,
          streamCount: selection.ranked.length,
          errors: selection.errors
        };
      }
      const limit = Math.max(1, Math.min(30, Number(args.limit || 10)));
      return {
        content: { type: resolved.type, id: resolved.id, videoId: resolved.videoId, selected: resolved.selected },
        preferences,
        streams: selection.ranked.slice(0, limit).map((entry, index) => summarizeRankedStream(entry, index)),
        providerCount: selection.providers.length,
        totalStreams: selection.ranked.length,
        errors: selection.errors
      };
    }
    if (tool === "home_assistant_stremio_proxy_status") {
      if (this.stremioProxyConfigError) return { ...this.selectorProxy.status(), configError: this.stremioProxyConfigError };
      return this.selectorProxy.status();
    }
    if (tool === "home_assistant_stremio_proxy_install") {
      if (this.stremioProxyConfigError) throw new Error(this.stremioProxyConfigError);
      if (!this.addonAggregator.configured) throw new Error("stremio_addon_manifests_required");
      await this.selectorProxy.ensureStarted();
      const uri = this.selectorProxy.installDeepLink();
      if (!uri) throw new Error("stremio_proxy_not_configured");
      return { proxy: this.selectorProxy.status(), launch: await this.launchStremio(uri) };
    }
    if (tool === "home_assistant_stremio_play_best") {
      if (this.stremioAddonConfigError) throw new Error(this.stremioAddonConfigError);
      if (!this.addonAggregator.configured) throw new Error("stremio_addon_manifests_required");
      const { resolved, streamId } = await this.resolveForStream(args);
      const preferences = this.streamPreferences(args);
      const selection = await this.addonAggregator.selectStream(resolved.type, streamId, preferences);
      if (!selection.selected) throw new Error("stremio_no_streams_found");
      const selected = summarizeRankedStream(selection.selected, 0);
      const useProxy = args.useSelectorProxy === undefined ? this.stremioProxyUseForPlay : Boolean(args.useSelectorProxy);

      if (useProxy) {
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
          content: { type: resolved.type, id: resolved.id, videoId: resolved.videoId, selected: resolved.selected },
          preferences,
          selected,
          deliveryMode: "selector_proxy_exact",
          proxy: { manifestUrl: this.selectorProxy.manifestUrl(), sessionId: proxySelection.sessionId },
          launch: await this.launchStremio(proxySelection.deepLink)
        };
      }

      const normalLink = detailDeepLink({
        type: resolved.type,
        id: resolved.id,
        videoId: resolved.videoId,
        autoPlay: false
      });
      return {
        content: { type: resolved.type, id: resolved.id, videoId: resolved.videoId, selected: resolved.selected },
        preferences,
        selected,
        deliveryMode: "visual_selection_required",
        visualSelectionHint: {
          addonName: selected.addonName,
          name: selected.name,
          title: selected.title,
          quality: selected.quality,
          languages: selected.languages,
          instruction: "Stremio deep links cannot inject a stream. After opening the detail/stream list, use home_assistant_tv_observe and select the visible stream matching this addon/title/quality. Do not accept a different stream merely because it appears first."
        },
        launch: await this.launchStremio(normalLink)
      };
    }
    if (tool === "home_assistant_stremio_open_page") {
      const page = String(args.page || "").toLowerCase();
      const uri = page === "board" ? boardDeepLink()
        : page === "discover" ? discoverDeepLink()
          : page === "library" ? libraryDeepLink()
            : null;
      if (!uri) throw new Error("stremio_page_invalid");
      return this.launchStremio(uri);
    }
    if (tool === "home_assistant_stremio_open_search") {
      return this.launchStremio(searchDeepLink(args.query));
    }
    if (tool === "home_assistant_stremio_open_detail") {
      return this.launchStremio(detailDeepLink({
        type: args.mediaType,
        id: args.id,
        videoId: args.videoId || null,
        autoPlay: autoPlay && Boolean(args.videoId)
      }));
    }
    if (tool === "home_assistant_stremio_play") {
      if (!args.query && !args.id) throw new Error("stremio_query_or_id_required");
      const resolved = await this.cinemeta.resolve({
        query: args.query,
        id: args.id,
        mediaType: args.mediaType || "auto",
        year: args.year,
        season: args.season,
        episode: args.episode,
        autoPlay
      });
      return { ...resolved, launch: await this.launchStremio(resolved.deepLink) };
    }
    if (tool === "home_assistant_stremio_adjacent_episode") {
      if (!args.query && !args.id) throw new Error("stremio_query_or_id_required");
      const resolved = await this.cinemeta.adjacentEpisode({
        query: args.query,
        id: args.id,
        year: args.year,
        currentSeason: args.currentSeason,
        currentEpisode: args.currentEpisode,
        direction: args.direction || "next",
        autoPlay
      });
      return { ...resolved, launch: await this.launchStremio(resolved.deepLink) };
    }
    if (tool === "home_assistant_stremio_open_catalog") {
      const uri = discoverCatalogDeepLink({
        manifestUrl: args.manifestUrl,
        type: args.mediaType,
        catalogId: args.catalogId,
        genre: args.genre || null
      });
      return this.launchStremio(uri);
    }
    if (tool === "home_assistant_stremio_open_addon") {
      return this.launchStremio(addonDeepLink(args.manifestUrl));
    }
    if (tool === "home_assistant_stremio_open_deep_link") {
      const uri = String(args.uri || "").trim();
      if (!isStremioDeepLink(uri)) throw new Error("stremio_deep_link_invalid_scheme");
      return this.launchStremio(uri);
    }
    throw new Error("stremio_tool_not_found");
  }

  async ensureMcpProxy(targetUrl) {
    if (this.mcpProxyServer && this.mcpProxyUrl && this.mcpProxyTarget === targetUrl) return this.mcpProxyUrl;
    if (this.mcpProxyServer) {
      await new Promise((resolve) => this.mcpProxyServer.close(() => resolve()));
      this.mcpProxyServer = null;
      this.mcpProxyUrl = "";
    }
    this.mcpProxyTarget = targetUrl;
    this.mcpProxyServer = createServer(async (request, response) => {
      try {
        const url = new URL(request.url || "/", "http://127.0.0.1");
        if (request.method !== "POST" || url.pathname !== this.mcpProxyPath) {
          sendJson(response, 404, { error: "not_found" });
          return;
        }
        const raw = await readRequestBody(request);
        let body;
        try { body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; }
        catch { sendJson(response, 400, { error: "invalid_json" }); return; }

        const tool = String(body?.tool || "");
        if (body?.type === "sol.plugin.mcp.invoke" && tool.startsWith("home_assistant_stremio_")) {
          try {
            const result = await this.handleStremioTool(tool, body?.arguments && typeof body.arguments === "object" ? body.arguments : {});
            sendJson(response, 200, result);
          } catch (error) {
            const message = error?.message || String(error);
            const status = message.includes("disabled") ? 403
              : message.includes("required") || message.includes("invalid") ? 400
                : message.includes("not_found") ? 404
                  : 500;
            sendJson(response, status, { error: message });
          }
          return;
        }

        const forwarded = await fetch(this.mcpProxyTarget, {
          method: "POST",
          headers: { "content-type": request.headers["content-type"] || "application/json" },
          body: raw,
          signal: AbortSignal.timeout(30000)
        });
        response.statusCode = forwarded.status;
        response.setHeader("content-type", forwarded.headers.get("content-type") || "application/json; charset=utf-8");
        response.end(Buffer.from(await forwarded.arrayBuffer()));
      } catch (error) {
        sendJson(response, 500, { error: error?.message || String(error) });
      }
    });

    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      this.mcpProxyServer.once("error", onError);
      this.mcpProxyServer.listen(0, "127.0.0.1", () => {
        this.mcpProxyServer.off("error", onError);
        resolve();
      });
    });
    this.mcpProxyServer.unref?.();
    const address = this.mcpProxyServer.address();
    if (!address || typeof address === "string") throw new Error("stremio_mcp_proxy_start_failed");
    this.mcpProxyUrl = `http://127.0.0.1:${address.port}${this.mcpProxyPath}`;
    return this.mcpProxyUrl;
  }

  async registerMcpTools(callbackUrl, tools) {
    if (!this.enabled) return [];
    const requestedTools = Array.isArray(tools) ? tools : [];
    if (!requestedTools.length || !this.stremioEnabled) {
      const result = await this.request("/v1/plugin-api/mcp/tools/register", {
        body: { callbackUrl, tools: requestedTools }
      });
      return result.tools || [];
    }

    const proxyUrl = await this.ensureMcpProxy(callbackUrl);
    const names = new Set(requestedTools.map((tool) => tool?.name).filter(Boolean));
    const stremioTools = STREMIO_MCP_TOOLS.filter((tool) => !names.has(tool.name));
    const result = await this.request("/v1/plugin-api/mcp/tools/register", {
      body: { callbackUrl: proxyUrl, tools: [...requestedTools, ...stremioTools] }
    });
    return result.tools || [];
  }
}
