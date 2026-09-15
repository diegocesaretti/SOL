import { SolPluginClientCore } from "./sol-client-core.mjs";
import {
  CinemetaClient,
  boardDeepLink,
  detailDeepLink,
  discoverDeepLink,
  isStremioDeepLink,
  libraryDeepLink,
  searchDeepLink
} from "./stremio.mjs";
import { StremioAccountClient, resolveNextEpisodeFromLibrary } from "./stremio-account.mjs";
import {
  chooseNativeStream,
  executeIndexedSelection,
  indexedNavigationTiming,
  planFromProviderSlices,
  queryAccountProviderSlices,
  waitForIndexedNavigation
} from "./stremio-indexed-selection.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function boolEnv(env, name, fallback = false) {
  const value = env?.[name];
  if (value === undefined || value === null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function numberEnv(env, name, fallback, min, max) {
  const value = Number(env?.[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function playbackRequestKey(args = {}, defaults = {}) {
  const key = {
    query: clean(args.query).toLowerCase(),
    id: clean(args.id),
    mediaType: clean(args.mediaType || "auto").toLowerCase(),
    year: args.year ?? null,
    season: args.season ?? null,
    episode: args.episode ?? null,
    quality: clean(args.quality || defaults.quality || "auto").toLowerCase(),
    language: clean(args.language || defaults.language || "any").toLowerCase(),
    autoPlay: args.autoPlay !== false
  };
  return JSON.stringify(key);
}

const CONTENT_PROPERTIES = {
  query: { type: "string", minLength: 1, maxLength: 300 },
  id: { type: "string", minLength: 1, maxLength: 300 },
  mediaType: { type: "string", enum: ["auto", "movie", "series"], default: "auto" },
  year: { type: "integer", minimum: 1880, maximum: 2200 },
  season: { type: "integer", minimum: 0, maximum: 10000 },
  episode: { type: "integer", minimum: 0, maximum: 10000 }
};

const PLAYBACK_PROPERTIES = {
  ...CONTENT_PROPERTIES,
  quality: { type: "string", enum: ["auto", "4k", "1080p", "720p", "480p"] },
  language: { type: "string", enum: ["any", "latin", "spanish", "english"] },
  autoPlay: { type: "boolean", default: true }
};

export const STREMIO_MCP_TOOLS = [
  {
    name: "home_assistant_stremio_status",
    description: "Report the single native-index Stremio playback status and timing configuration.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredScope: "read"
  },
  {
    name: "home_assistant_stremio_search",
    description: "Search Cinemeta by title. Does not launch the TV.",
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
    description: "Resolve a movie or series. For series without an explicit episode, linked Stremio history may select the episode to resume or play next.",
    inputSchema: { type: "object", properties: CONTENT_PROPERTIES, additionalProperties: false },
    requiredScope: "read"
  },
  {
    name: "home_assistant_stremio_play_best",
    description: "Exclusive playback action. Call exactly once for a play request: resolve content, query linked-account stream addons in native order, prove the absolute stream index, open official Stremio once, wait, navigate one key at a time and send one final select key. Do not pair with open-page or open-search actions.",
    inputSchema: { type: "object", properties: PLAYBACK_PROPERTIES, additionalProperties: false },
    requiredScope: "actions"
  },
  {
    name: "home_assistant_stremio_open_page",
    description: "Standalone navigation action: open the official Stremio Board, Discover or Library page. Do not use as part of a play_best request.",
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
    description: "Standalone navigation action: open the official Stremio search page with a query. Do not use as part of a play_best request.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1, maxLength: 300 } },
      required: ["query"],
      additionalProperties: false
    },
    requiredScope: "actions"
  },
  {
    name: "home_assistant_stremio_account_status",
    description: "Report sanitized linked Stremio account status and counts.",
    inputSchema: { type: "object", properties: { refresh: { type: "boolean", default: false } }, additionalProperties: false },
    requiredScope: "read"
  },
  {
    name: "home_assistant_stremio_library",
    description: "List sanitized items from the linked Stremio library.",
    inputSchema: {
      type: "object",
      properties: {
        mediaType: { type: "string", enum: ["all", "movie", "series"], default: "all" },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        refresh: { type: "boolean", default: false }
      },
      additionalProperties: false
    },
    requiredScope: "read"
  },
  {
    name: "home_assistant_stremio_continue_watching",
    description: "List Continue Watching items from the linked Stremio account.",
    inputSchema: {
      type: "object",
      properties: {
        mediaType: { type: "string", enum: ["all", "movie", "series"], default: "all" },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        refresh: { type: "boolean", default: false }
      },
      additionalProperties: false
    },
    requiredScope: "read"
  },
  {
    name: "home_assistant_stremio_next_episode",
    description: "Resolve the episode to resume or play next using linked Stremio history. Does not launch the TV.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 300 },
        id: { type: "string", minLength: 1, maxLength: 300 },
        year: { type: "integer", minimum: 1880, maximum: 2200 },
        refresh: { type: "boolean", default: false }
      },
      additionalProperties: false
    },
    requiredScope: "read"
  }
];

export class SolPluginClient extends SolPluginClientCore {
  constructor(env = process.env) {
    super(env);
    this.stremioEnabled = boolEnv(env, "HA_SOL_STREMIO_ENABLED", true);
    this.allowControl = boolEnv(env, "HA_SOL_ALLOW_CONTROL", false);
    this.stremioRemoteEntityId = clean(env.HA_SOL_TV_REMOTE_ENTITY_ID);
    this.stremioTimeoutMs = 8000;
    this.stremioAddonTimeoutMs = numberEnv(env, "HA_SOL_STREMIO_ADDON_TIMEOUT_MS", 20000, 1000, 120000);
    this.stremioAddonRetries = 1;
    this.stremioPlaybackDedupeMs = numberEnv(env, "HA_SOL_STREMIO_PLAYBACK_DEDUPE_MS", 30000, 0, 120000);
    this.stremioPlaybackInFlight = new Map();
    this.stremioPlaybackRecent = new Map();
    this.haUrl = clean(env.HA_URL).replace(/\/$/, "");
    this.haToken = clean(env.HA_TOKEN);
    this.cinemeta = new CinemetaClient({ timeoutMs: this.stremioTimeoutMs });
    this.defaultPreferences = {
      quality: clean(env.HA_SOL_STREMIO_DEFAULT_QUALITY || "1080p").toLowerCase(),
      language: clean(env.HA_SOL_STREMIO_DEFAULT_LANGUAGE || "any").toLowerCase()
    };
    this.account = new StremioAccountClient({
      enabled: boolEnv(env, "HA_SOL_STREMIO_ACCOUNT_ENABLED", false),
      authKey: env.HA_SOL_STREMIO_ACCOUNT_AUTH_KEY || "",
      email: env.HA_SOL_STREMIO_ACCOUNT_EMAIL || "",
      password: env.HA_SOL_STREMIO_ACCOUNT_PASSWORD || "",
      timeoutMs: 12000,
      refreshMs: 60000
    });
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
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`home_assistant_service_http_${response.status}`);
    return payload;
  }

  streamPreferences(args = {}) {
    return {
      quality: clean(args.quality || this.defaultPreferences.quality || "auto").toLowerCase(),
      language: clean(args.language || this.defaultPreferences.language || "any").toLowerCase()
    };
  }

  async refreshAccount(force = false) {
    if (!this.account.configured) throw new Error("stremio_account_required_for_native_index_selection");
    return this.account.refresh({ force });
  }

  async resolveForStream(args = {}) {
    let request = { ...args };
    if (!request.query && !request.id) {
      if (!this.account.configured) throw new Error("stremio_query_or_id_required");
      await this.refreshAccount(false);
      const recent = this.account.mostRecentSeries();
      if (!recent) throw new Error("stremio_account_no_recent_series");
      request = { ...request, id: recent.mediaId, mediaType: "series" };
    }

    const explicitEpisode = request.season !== undefined && request.season !== null
      && request.episode !== undefined && request.episode !== null;
    if (explicitEpisode) {
      const resolved = await this.cinemeta.resolve({
        query: request.query,
        id: request.id,
        mediaType: request.mediaType || "auto",
        year: request.year,
        season: request.season,
        episode: request.episode,
        autoPlay: false
      });
      return { resolved, streamId: resolved.videoId || resolved.id, episodeDecision: null };
    }

    const base = await this.cinemeta.resolve({
      query: request.query,
      id: request.id,
      mediaType: request.mediaType || "auto",
      year: request.year,
      autoPlay: false
    });
    if (base.type !== "series") return { resolved: base, streamId: base.videoId || base.id, episodeDecision: null };

    const meta = await this.cinemeta.meta("series", base.id);
    let decision;
    if (this.account.configured) {
      await this.refreshAccount(false);
      decision = this.account.nextEpisode(meta);
    } else {
      decision = resolveNextEpisodeFromLibrary(meta, null);
    }
    if (!decision.episode) {
      if (decision.status === "caught_up") throw new Error("stremio_series_caught_up");
      throw new Error("stremio_series_no_released_episode");
    }
    const resolved = await this.cinemeta.resolve({
      id: base.id,
      mediaType: "series",
      season: decision.episode.season,
      episode: decision.episode.episode,
      autoPlay: false
    });
    return {
      resolved,
      streamId: resolved.videoId || decision.episode.id,
      episodeDecision: {
        status: decision.status,
        season: decision.episode.season,
        episode: decision.episode.episode,
        videoId: decision.episode.id,
        title: decision.episode.title,
        progressPercent: decision.history?.progressPercent ?? null,
        watchedBitfieldUsed: decision.history?.watchedBitfieldUsed ?? false
      }
    };
  }

  async launchStremio(uri) {
    if (!this.stremioEnabled) throw new Error("stremio_deep_links_disabled");
    if (!this.allowControl) throw new Error("home_assistant_control_disabled");
    if (!this.stremioRemoteEntityId) throw new Error("tv_remote_entity_id_required");
    if (!isStremioDeepLink(uri)) throw new Error("stremio_deep_link_invalid_scheme");
    const result = await this.haService("remote", "turn_on", {
      entity_id: this.stremioRemoteEntityId,
      activity: uri
    });
    return { ok: true, via: "home_assistant_remote_turn_on", deepLink: uri, result };
  }

  stremioStatus() {
    return {
      enabled: this.stremioEnabled,
      architecture: "single_path_native_indexed",
      officialStremioOnly: true,
      remoteEntityId: this.stremioRemoteEntityId || null,
      account: this.account.snapshot(),
      defaults: this.defaultPreferences,
      timing: indexedNavigationTiming(this.env),
      playbackDedupeMs: this.stremioPlaybackDedupeMs
    };
  }

  async playBest(args = {}) {
    if (!this.stremioEnabled) throw new Error("stremio_deep_links_disabled");
    if (!this.allowControl) throw new Error("home_assistant_control_disabled");
    if (!this.account.configured) throw new Error("stremio_account_required_for_native_index_selection");

    const { resolved, streamId, episodeDecision } = await this.resolveForStream(args);
    const preferences = this.streamPreferences(args);
    const queried = await queryAccountProviderSlices(this, {
      mediaType: resolved.type,
      mediaId: streamId
    }, this.account);
    const choice = chooseNativeStream(queried.slices, preferences);
    if (!choice.ok) {
      return {
        playbackRequested: false,
        failClosed: true,
        content: { type: resolved.type, id: resolved.id, videoId: resolved.videoId, selected: resolved.selected },
        preferences,
        episodeDecision,
        selection: choice,
        providerErrors: queried.slices.filter((slice) => slice.error).map((slice) => ({ addonId: slice.addonId, error: slice.error }))
      };
    }

    const plan = planFromProviderSlices(queried.slices, choice.selected, { maxIndex: 100 });
    if (!plan.ok) {
      return {
        playbackRequested: false,
        failClosed: true,
        content: { type: resolved.type, id: resolved.id, videoId: resolved.videoId, selected: resolved.selected },
        preferences,
        episodeDecision,
        selected: choice.selected,
        indexedSelection: plan
      };
    }

    const nativeLink = detailDeepLink({
      type: resolved.type,
      id: resolved.id,
      videoId: resolved.videoId || streamId || resolved.id,
      autoPlay: false
    });
    const launch = await this.launchStremio(nativeLink);

    if (args.autoPlay === false) {
      return {
        playbackRequested: false,
        content: { type: resolved.type, id: resolved.id, videoId: resolved.videoId, selected: resolved.selected },
        preferences,
        episodeDecision,
        selected: choice.selected,
        indexedSelection: plan,
        launch
      };
    }

    const timing = await waitForIndexedNavigation(this.env);
    const selection = await executeIndexedSelection(this, plan, timing);
    return {
      playbackRequested: true,
      playbackConfirmed: null,
      content: { type: resolved.type, id: resolved.id, videoId: resolved.videoId, selected: resolved.selected },
      preferences,
      episodeDecision,
      selected: choice.selected,
      indexedSelection: plan,
      timing,
      launch,
      keySequence: selection,
      providerCount: queried.addons.length,
      providerErrors: queried.slices.filter((slice) => slice.error).map((slice) => ({ addonId: slice.addonId, error: slice.error })),
      failClosed: true
    };
  }

  async playBestDeduped(args = {}) {
    const key = playbackRequestKey(args, this.defaultPreferences);
    const now = Date.now();
    for (const [recentKey, entry] of this.stremioPlaybackRecent) {
      if (now - entry.completedAt > this.stremioPlaybackDedupeMs) this.stremioPlaybackRecent.delete(recentKey);
    }

    const inFlight = this.stremioPlaybackInFlight.get(key);
    if (inFlight) {
      const result = await inFlight;
      return { ...result, deduplicated: true, dedupeReason: "identical_playback_in_flight" };
    }

    const recent = this.stremioPlaybackRecent.get(key);
    if (recent && this.stremioPlaybackDedupeMs > 0 && now - recent.completedAt <= this.stremioPlaybackDedupeMs) {
      return { ...recent.result, deduplicated: true, dedupeReason: "identical_playback_recently_completed" };
    }

    const run = this.playBest(args);
    this.stremioPlaybackInFlight.set(key, run);
    try {
      const result = await run;
      if (this.stremioPlaybackDedupeMs > 0) {
        this.stremioPlaybackRecent.set(key, { completedAt: Date.now(), result });
      }
      return result;
    } finally {
      this.stremioPlaybackInFlight.delete(key);
    }
  }

  async handleStremioTool(tool, args = {}) {
    if (tool === "home_assistant_stremio_status") return this.stremioStatus();
    if (tool === "home_assistant_stremio_search") {
      return {
        query: clean(args.query),
        results: await this.cinemeta.search(args.query, {
          mediaType: args.mediaType || "auto",
          year: args.year,
          limit: args.limit || 10
        })
      };
    }
    if (tool === "home_assistant_stremio_resolve") {
      const result = await this.resolveForStream(args);
      return { ...result.resolved, episodeDecision: result.episodeDecision };
    }
    if (tool === "home_assistant_stremio_play_best") return this.playBestDeduped(args);
    if (tool === "home_assistant_stremio_account_status") {
      if (args.refresh && this.account.configured) await this.refreshAccount(true);
      return this.account.snapshot();
    }
    if (tool === "home_assistant_stremio_library") {
      await this.refreshAccount(Boolean(args.refresh));
      return { ...this.account.snapshot(), items: this.account.safeLibrary({ mediaType: args.mediaType || "all", limit: args.limit || 100 }) };
    }
    if (tool === "home_assistant_stremio_continue_watching") {
      await this.refreshAccount(Boolean(args.refresh));
      return { ...this.account.snapshot(), items: this.account.continueWatching({ mediaType: args.mediaType || "all", limit: args.limit || 50 }) };
    }
    if (tool === "home_assistant_stremio_next_episode") {
      if (!args.query && !args.id) throw new Error("stremio_query_or_id_required");
      await this.refreshAccount(Boolean(args.refresh));
      const base = await this.cinemeta.resolve({ query: args.query, id: args.id, mediaType: "series", year: args.year, autoPlay: false });
      const meta = await this.cinemeta.meta("series", base.id);
      const decision = this.account.nextEpisode(meta);
      return {
        series: { id: base.id, name: base.selected?.name || meta.name || null },
        decision: decision.episode ? {
          status: decision.status,
          season: decision.episode.season,
          episode: decision.episode.episode,
          videoId: decision.episode.id,
          title: decision.episode.title,
          progressPercent: decision.history?.progressPercent ?? null
        } : { status: decision.status, episode: null }
      };
    }
    if (tool === "home_assistant_stremio_open_page") {
      const page = clean(args.page).toLowerCase();
      const uri = page === "board" ? boardDeepLink()
        : page === "discover" ? discoverDeepLink()
          : page === "library" ? libraryDeepLink()
            : null;
      if (!uri) throw new Error("stremio_page_invalid");
      return this.launchStremio(uri);
    }
    if (tool === "home_assistant_stremio_open_search") return this.launchStremio(searchDeepLink(args.query));
    throw new Error("stremio_tool_not_found");
  }
}
