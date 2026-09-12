import { AsyncLocalStorage } from "node:async_hooks";
import {
  StremioAddonAggregator,
  inspectStream,
  parseAddonManifestList
} from "./stremio-addons.mjs";
import { installStremioAddonCompatibilityPatch } from "./stremio-addon-compat.mjs";
import {
  StremioAccountClient,
  resolveNextEpisodeFromLibrary
} from "./stremio-account.mjs";

const playbackContext = new AsyncLocalStorage();
const PROFILE_VALUES = ["auto", "default", "family", "sports"];
const STREAM_TOOLS = new Set([
  "home_assistant_stremio_streams",
  "home_assistant_stremio_select_stream",
  "home_assistant_stremio_play_best"
]);

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

function normalizeText(value) {
  return clean(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseList(value, fallback = []) {
  const text = clean(value);
  if (!text) return [...fallback];
  return text.split(/[;\n\r,]+/g).map(normalizeText).filter(Boolean);
}

function parseManifests(value) {
  try {
    return { urls: parseAddonManifestList(value || ""), error: null };
  } catch (error) {
    return { urls: [], error: error?.message || String(error) };
  }
}

function createAggregator(client, urls, { preserveAddonOrder = true } = {}) {
  const aggregator = new StremioAddonAggregator({
    manifestUrls: [...new Set(urls)],
    timeoutMs: client.stremioAddonTimeoutMs || client.stremioTimeoutMs || 20000
  });
  installStremioAddonCompatibilityPatch(aggregator, {
    retries: client.stremioAddonRetries || 0,
    preserveAddonOrder
  });
  return aggregator;
}

function languagesForEntry(entry) {
  const details = entry?.details || inspectStream(entry?.stream || {});
  return Array.isArray(details.languages) ? details.languages : [];
}

function familySpanishSelection(selection) {
  const ranked = (selection?.ranked || []).filter((entry) => {
    const languages = languagesForEntry(entry);
    return languages.includes("spanish") || languages.includes("latin");
  });
  return {
    ...selection,
    selected: ranked[0] || null,
    ranked,
    familyLanguageFilter: "spanish_or_latin_hard_filter"
  };
}

function currentProfile(runtime) {
  const store = playbackContext.getStore();
  const requested = clean(store?.effectiveProfile || store?.requestedProfile || "default").toLowerCase();
  return PROFILE_VALUES.includes(requested) && requested !== "auto" ? requested : "default";
}

class ProfileAddonRouter {
  constructor(runtime) {
    this.runtime = runtime;
  }

  aggregator(profile = currentProfile(this.runtime)) {
    if (profile === "family") return this.runtime.familyAggregator;
    if (profile === "sports") return this.runtime.sportsAggregator;
    return this.runtime.effectiveDefaultAggregator || this.runtime.defaultAggregator;
  }

  get configured() {
    return this.aggregator().configured;
  }

  get manifestUrls() {
    return this.aggregator().manifestUrls;
  }

  get timeoutMs() {
    return this.aggregator().timeoutMs;
  }

  set timeoutMs(value) {
    for (const aggregator of [
      this.runtime.defaultAggregator,
      this.runtime.effectiveDefaultAggregator,
      this.runtime.familyAggregator,
      this.runtime.sportsAggregator
    ]) {
      if (aggregator) aggregator.timeoutMs = value;
    }
  }

  get preserveAddonOrder() {
    return this.aggregator().preserveAddonOrder;
  }

  async refresh(options = {}) {
    return this.aggregator().refresh(options);
  }

  async status(options = {}) {
    const profile = currentProfile(this.runtime);
    const status = await this.aggregator(profile).status(options);
    return { ...status, profile };
  }

  async getStreams(mediaType, mediaId, options = {}) {
    return this.aggregator().getStreams(mediaType, mediaId, options);
  }

  async rankStreams(mediaType, mediaId, preferences = {}) {
    return this.aggregator().rankStreams(mediaType, mediaId, preferences);
  }

  async selectStream(mediaType, mediaId, preferences = {}) {
    const profile = currentProfile(this.runtime);
    const store = playbackContext.getStore();
    if (store?.cachedSelection
      && store.cachedSelection.profile === profile
      && store.cachedSelection.mediaType === mediaType
      && store.cachedSelection.mediaId === mediaId) {
      return store.cachedSelection.selection;
    }

    const aggregator = this.aggregator(profile);
    if ((profile === "family" || profile === "sports") && !aggregator.configured) {
      throw new Error(profile === "family"
        ? "stremio_family_provider_required"
        : "stremio_sports_provider_required");
    }
    let selection = await aggregator.selectStream(mediaType, mediaId, preferences);
    if (profile === "family" && this.runtime.familyRequireSpanish) {
      selection = familySpanishSelection(selection);
      if (!selection.selected) throw new Error("stremio_family_no_spanish_streams");
    }
    if (store) {
      store.cachedSelection = { profile, mediaType, mediaId, selection };
    }
    return selection;
  }
}

export function classifyPlaybackProfile(resolved, {
  requestedProfile = "auto",
  familyEnabled = false,
  familyTitles = [],
  familyGenres = ["family", "kids", "children"]
} = {}) {
  const requested = clean(requestedProfile || "auto").toLowerCase();
  if (requested !== "auto") return PROFILE_VALUES.includes(requested) ? requested : "default";
  if (!familyEnabled) return "default";

  const selected = resolved?.selected || {};
  const title = normalizeText(selected.name || resolved?.name || "");
  if (title && familyTitles.some((item) => item === title)) return "family";
  const genres = (Array.isArray(selected.genres) ? selected.genres : [])
    .map(normalizeText)
    .filter(Boolean);
  if (genres.some((genre) => familyGenres.includes(genre))) return "family";
  return "default";
}

function installToolSchemas(tools) {
  const profileProperty = {
    type: "string",
    enum: PROFILE_VALUES,
    default: "auto",
    description: "Playback provider profile. auto routes Family/Kids metadata and configured forced titles to the isolated family provider; default uses normal providers; sports uses its dedicated provider."
  };
  const profileTools = new Set([
    "home_assistant_stremio_resolve",
    "home_assistant_stremio_addons",
    "home_assistant_stremio_streams",
    "home_assistant_stremio_select_stream",
    "home_assistant_stremio_play_best",
    "home_assistant_stremio_play"
  ]);
  for (const tool of tools) {
    if (profileTools.has(tool?.name) && tool?.inputSchema?.properties) {
      tool.inputSchema.properties.profile = profileProperty;
    }
  }

  const playBest = tools.find((tool) => tool?.name === "home_assistant_stremio_play_best");
  if (playBest) {
    playBest.description = "Resolve a movie or series, use linked Stremio account history to choose/resume the correct episode when season/episode are omitted, route the request through default/family/sports provider profiles, then launch the standard Play Store Stremio app. Family mode is fail-closed: it never falls back to the generic first stream.";
  }
  const resolve = tools.find((tool) => tool?.name === "home_assistant_stremio_resolve");
  if (resolve) {
    resolve.description = "Resolve content without launching. For an implicit series request, linked Stremio history chooses an in-progress episode or the next unwatched released episode; without account history it starts at the first released regular episode.";
  }

  const additions = [
    {
      name: "home_assistant_stremio_account_status",
      description: "Report sanitized Stremio account sync status, library counts and installed-addon counts. Never returns auth keys, passwords or private addon URLs.",
      inputSchema: { type: "object", properties: { refresh: { type: "boolean", default: false } }, additionalProperties: false },
      requiredScope: "read"
    },
    {
      name: "home_assistant_stremio_library",
      description: "List sanitized items from the linked Stremio library, including resume progress and last watched episode, without account secrets.",
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
      description: "List the linked Stremio account's Continue Watching items, most recent first.",
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
      name: "home_assistant_stremio_account_addons",
      description: "List safe names/versions/roles of addons installed in the linked Stremio account. Private transport URLs remain secret.",
      inputSchema: { type: "object", properties: { refresh: { type: "boolean", default: false } }, additionalProperties: false },
      requiredScope: "read"
    },
    {
      name: "home_assistant_stremio_next_episode",
      description: "Resolve which episode should play next for a series using Stremio watched bitfield plus resume progress. Does not launch the TV.",
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
  for (const tool of additions) {
    if (!tools.some((entry) => entry?.name === tool.name)) tools.push(tool);
  }
}

function runtimeStatus(runtime) {
  return {
    account: runtime.account.snapshot(),
    profiles: {
      default: {
        configured: runtime.defaultAggregator.configured,
        includeAccountAddons: runtime.includeAccountAddons,
        effectiveConfiguredCount: runtime.effectiveDefaultAggregator?.manifestUrls?.length ?? runtime.defaultAggregator.manifestUrls.length
      },
      family: {
        enabled: runtime.familyEnabled,
        configured: runtime.familyAggregator.configured,
        configError: runtime.familyConfigError,
        requireSpanish: runtime.familyRequireSpanish,
        autoGenres: runtime.familyGenres,
        forcedTitleCount: runtime.familyTitles.length,
        isolation: "Only family manifests are queried. Generic first-stream DPAD_CENTER fallback is disabled in family mode; visual provider matching must succeed or playback remains unselected."
      },
      sports: {
        configured: runtime.sportsAggregator.configured,
        configError: runtime.sportsConfigError
      }
    }
  };
}

function ensureRuntime(client) {
  if (client.__stremioSmartRuntime) return client.__stremioSmartRuntime;
  const env = client.env || process.env;
  const familyParsed = parseManifests(env.HA_SOL_STREMIO_FAMILY_ADDONS || "");
  const sportsParsed = parseManifests(env.HA_SOL_STREMIO_SPORTS_ADDONS || "");
  const defaultAggregator = client.addonAggregator;
  const preserveAddonOrder = boolEnv(env, "HA_SOL_STREMIO_PRESERVE_ADDON_ORDER", true);
  const runtime = {
    account: new StremioAccountClient({
      enabled: boolEnv(env, "HA_SOL_STREMIO_ACCOUNT_ENABLED", false),
      authKey: env.HA_SOL_STREMIO_ACCOUNT_AUTH_KEY || "",
      email: env.HA_SOL_STREMIO_ACCOUNT_EMAIL || "",
      password: env.HA_SOL_STREMIO_ACCOUNT_PASSWORD || "",
      timeoutMs: numberEnv(env, "HA_SOL_STREMIO_ACCOUNT_TIMEOUT_MS", 12000, 1000, 30000),
      refreshMs: numberEnv(env, "HA_SOL_STREMIO_ACCOUNT_REFRESH_MS", 60000, 5000, 3600000)
    }),
    includeAccountAddons: boolEnv(env, "HA_SOL_STREMIO_ACCOUNT_INCLUDE_ADDONS", false),
    defaultAggregator,
    effectiveDefaultAggregator: defaultAggregator,
    effectiveDefaultSignature: defaultAggregator.manifestUrls.join("\n"),
    familyAggregator: createAggregator(client, familyParsed.urls, { preserveAddonOrder: true }),
    sportsAggregator: createAggregator(client, sportsParsed.urls, { preserveAddonOrder }),
    familyConfigError: familyParsed.error,
    sportsConfigError: sportsParsed.error,
    familyEnabled: boolEnv(env, "HA_SOL_STREMIO_FAMILY_ENABLED", familyParsed.urls.length > 0),
    familyRequireSpanish: boolEnv(env, "HA_SOL_STREMIO_FAMILY_REQUIRE_SPANISH", true),
    familyTitles: parseList(env.HA_SOL_STREMIO_FAMILY_TITLES || ""),
    familyGenres: parseList(env.HA_SOL_STREMIO_FAMILY_GENRES || "", ["family", "kids", "children"])
  };
  runtime.router = new ProfileAddonRouter(runtime);
  client.addonAggregator = runtime.router;
  client.__stremioSmartRuntime = runtime;
  return runtime;
}

async function refreshAccount(client, runtime, { force = false } = {}) {
  if (!runtime.account.configured) return runtime.account.snapshot();
  const snapshot = await runtime.account.refresh({ force });
  if (!runtime.includeAccountAddons) return snapshot;

  const accountUrls = runtime.account.streamManifestUrls();
  const normalized = [];
  for (const url of [...runtime.defaultAggregator.manifestUrls, ...accountUrls]) {
    try {
      normalized.push(...parseAddonManifestList(url));
    } catch {
      // A malformed account transport must not poison the configured default provider.
    }
  }
  const urls = [...new Set(normalized)];
  const signature = urls.join("\n");
  if (signature !== runtime.effectiveDefaultSignature) {
    runtime.effectiveDefaultAggregator = createAggregator(client, urls, {
      preserveAddonOrder: boolEnv(client.env, "HA_SOL_STREMIO_PRESERVE_ADDON_ORDER", true)
    });
    runtime.effectiveDefaultSignature = signature;
  }
  return snapshot;
}

function smartContextSummary(store) {
  if (!store) return null;
  return {
    requestedProfile: store.requestedProfile || "auto",
    effectiveProfile: store.effectiveProfile || "default",
    episodeDecision: store.episodeDecision || null,
    familyFailClosed: store.effectiveProfile === "family"
  };
}

export function installStremioSmartPlayback(SolPluginClient, tools = []) {
  const proto = SolPluginClient?.prototype;
  if (!proto || proto.__stremioSmartPlaybackInstalled) return SolPluginClient;
  proto.__stremioSmartPlaybackInstalled = true;
  installToolSchemas(tools);

  const originalResolveForStream = proto.resolveForStream;
  const originalStatus = proto.stremioStatus;
  const originalHandle = proto.handleStremioTool;
  const originalClickFirstStream = proto.clickFirstStream;

  proto.stremioStatus = function stremioStatusSmart() {
    const runtime = ensureRuntime(this);
    return { ...originalStatus.call(this), smartPlayback: runtimeStatus(runtime) };
  };

  proto.resolveForStream = async function resolveForStreamSmart(args = {}) {
    const runtime = ensureRuntime(this);
    const store = playbackContext.getStore();
    let request = { ...args };
    const explicitEpisode = request.season !== undefined && request.season !== null
      && request.episode !== undefined && request.episode !== null;

    if (!request.query && !request.id && runtime.account.configured) {
      await refreshAccount(this, runtime, { force: false });
      const recent = runtime.account.mostRecentSeries();
      if (!recent) throw new Error("stremio_account_no_recent_series");
      request = { ...request, id: recent.mediaId, mediaType: "series" };
      if (store) store.accountImplicitSeries = true;
    }

    let result;
    if (explicitEpisode) {
      result = await originalResolveForStream.call(this, request);
    } else {
      if (!request.query && !request.id) throw new Error("stremio_query_or_id_required");
      const base = await this.cinemeta.resolve({
        query: request.query,
        id: request.id,
        mediaType: request.mediaType || "auto",
        year: request.year,
        autoPlay: false
      });

      if (base.type !== "series") {
        result = { resolved: base, streamId: base.videoId || base.id };
      } else {
        const meta = await this.cinemeta.meta("series", base.id);
        let decision;
        if (runtime.account.configured) {
          await refreshAccount(this, runtime, { force: false });
          decision = runtime.account.nextEpisode(meta);
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
        result = { resolved, streamId: resolved.videoId || decision.episode.id };
        if (store) store.episodeDecision = {
          status: decision.status,
          season: decision.episode.season,
          episode: decision.episode.episode,
          videoId: decision.episode.id,
          title: decision.episode.title,
          progressPercent: decision.history?.progressPercent ?? null,
          watchedBitfieldUsed: decision.history?.watchedBitfieldUsed ?? false
        };
      }
    }

    const effectiveProfile = classifyPlaybackProfile(result.resolved, {
      requestedProfile: request.profile || store?.requestedProfile || "auto",
      familyEnabled: runtime.familyEnabled,
      familyTitles: runtime.familyTitles,
      familyGenres: runtime.familyGenres
    });
    if (store) store.effectiveProfile = effectiveProfile;

    if (effectiveProfile === "family") {
      if (runtime.familyConfigError) throw new Error(runtime.familyConfigError);
      if (!runtime.familyAggregator.configured) throw new Error("stremio_family_provider_required");
      // Family is fail-closed. Validate a Spanish/Latin stream before Stremio is launched,
      // and cache the selection for the normal play_best flow.
      const preferences = this.streamPreferences({ ...request, language: request.language || "spanish" });
      const selection = await runtime.router.selectStream(result.resolved.type, result.streamId, preferences);
      if (store) store.cachedSelection = {
        profile: "family",
        mediaType: result.resolved.type,
        mediaId: result.streamId,
        selection
      };
    } else if (effectiveProfile === "sports") {
      if (runtime.sportsConfigError) throw new Error(runtime.sportsConfigError);
      if (!runtime.sportsAggregator.configured) throw new Error("stremio_sports_provider_required");
    }

    return result;
  };

  proto.clickFirstStream = async function clickFirstStreamProfileAware(...args) {
    const store = playbackContext.getStore();
    if (store?.effectiveProfile === "family") {
      return {
        ok: false,
        commandSent: false,
        reason: "stremio_family_profile_requires_visual_provider_match",
        familyFailClosed: true,
        note: "No generic DPAD_CENTER is sent in family mode. Only the prevalidated family-provider stream may be selected visually."
      };
    }
    return originalClickFirstStream.apply(this, args);
  };

  proto.handleStremioTool = async function handleStremioToolSmart(tool, args = {}) {
    const runtime = ensureRuntime(this);

    if (tool === "home_assistant_stremio_account_status") {
      if (runtime.account.configured && args.refresh) await refreshAccount(this, runtime, { force: true });
      return runtime.account.snapshot();
    }
    if (tool === "home_assistant_stremio_library") {
      await refreshAccount(this, runtime, { force: Boolean(args.refresh) });
      return {
        ...runtime.account.snapshot(),
        items: runtime.account.safeLibrary({ mediaType: args.mediaType || "all", limit: args.limit || 100 })
      };
    }
    if (tool === "home_assistant_stremio_continue_watching") {
      await refreshAccount(this, runtime, { force: Boolean(args.refresh) });
      return {
        ...runtime.account.snapshot(),
        items: runtime.account.continueWatching({ mediaType: args.mediaType || "all", limit: args.limit || 50 })
      };
    }
    if (tool === "home_assistant_stremio_account_addons") {
      await refreshAccount(this, runtime, { force: Boolean(args.refresh) });
      return { ...runtime.account.snapshot(), addons: runtime.account.safeAddons() };
    }
    if (tool === "home_assistant_stremio_next_episode") {
      if (!args.query && !args.id) throw new Error("stremio_query_or_id_required");
      await refreshAccount(this, runtime, { force: Boolean(args.refresh) });
      const base = await this.cinemeta.resolve({
        query: args.query,
        id: args.id,
        mediaType: "series",
        year: args.year,
        autoPlay: false
      });
      const meta = await this.cinemeta.meta("series", base.id);
      const decision = runtime.account.nextEpisode(meta);
      return {
        series: { id: base.id, name: base.selected?.name || meta.name || null },
        decision: decision.episode ? {
          status: decision.status,
          season: decision.episode.season,
          episode: decision.episode.episode,
          videoId: decision.episode.id,
          title: decision.episode.title,
          progressPercent: decision.history?.progressPercent ?? null,
          watchedBitfieldUsed: decision.history?.watchedBitfieldUsed ?? false
        } : { status: decision.status, episode: null }
      };
    }

    const requestedProfile = clean(args.profile || "auto").toLowerCase();
    const store = {
      requestedProfile: PROFILE_VALUES.includes(requestedProfile) ? requestedProfile : "auto",
      effectiveProfile: requestedProfile !== "auto" && PROFILE_VALUES.includes(requestedProfile) ? requestedProfile : null,
      episodeDecision: null,
      cachedSelection: null
    };

    return playbackContext.run(store, async () => {
      if (runtime.includeAccountAddons && runtime.account.configured && STREAM_TOOLS.has(tool)) {
        await refreshAccount(this, runtime, { force: false });
      }

      if (tool === "home_assistant_stremio_resolve") {
        const { resolved } = await this.resolveForStream(args);
        const autoPlay = args.autoPlay === undefined ? this.stremioAutoPlayDefault : Boolean(args.autoPlay);
        const finalResolved = await this.cinemeta.resolve({
          id: resolved.id,
          mediaType: resolved.type,
          season: resolved.season,
          episode: resolved.episode,
          autoPlay
        });
        return { ...finalResolved, smartPlayback: smartContextSummary(store) };
      }

      if (tool === "home_assistant_stremio_addons") {
        if (store.requestedProfile === "auto") store.effectiveProfile = "default";
        const result = await originalHandle.call(this, tool, args);
        return { ...result, playbackProfile: currentProfile(runtime), smartPlayback: smartContextSummary(store) };
      }

      // Keep family requests on the profile-aware play_best path even if a caller
      // chooses the legacy play tool, otherwise native Stremio could select a generic addon.
      if (tool === "home_assistant_stremio_play" && store.requestedProfile === "family") {
        const result = await originalHandle.call(this, "home_assistant_stremio_play_best", args);
        return { ...result, smartPlayback: smartContextSummary(store) };
      }

      const result = await originalHandle.call(this, tool, args);
      if (STREAM_TOOLS.has(tool) || tool === "home_assistant_stremio_play") {
        return {
          ...result,
          playbackProfile: currentProfile(runtime),
          smartPlayback: smartContextSummary(store),
          ...(store.effectiveProfile === "family" ? {
            familyIsolation: {
              failClosed: true,
              queriedProviderProfile: "family_only",
              genericFirstStreamFallback: false,
              exactNativeProviderInjection: false,
              note: "The standard Stremio deep-link protocol cannot inject a provider. SOL therefore prevalidates only the family provider and refuses the generic first-stream click; if visual matching cannot identify the selected family stream, playback remains unselected."
            }
          } : {})
        };
      }
      return result;
    });
  };

  return SolPluginClient;
}

export const __test = {
  familySpanishSelection,
  normalizeText,
  parseList
};
