import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PROFILE_TOOLS = new Set([
  "home_assistant_stremio_resolve",
  "home_assistant_stremio_addons",
  "home_assistant_stremio_streams",
  "home_assistant_stremio_select_stream",
  "home_assistant_stremio_play_best",
  "home_assistant_stremio_play"
]);

const CLASSIFIABLE_TOOLS = new Set([
  "home_assistant_stremio_resolve",
  "home_assistant_stremio_streams",
  "home_assistant_stremio_select_stream",
  "home_assistant_stremio_play_best",
  "home_assistant_stremio_play"
]);

const KIDS_RATINGS = new Set(["g", "tv y", "tv y7", "tv g"]);
const FAMILY_RATINGS = new Set(["pg", "tv pg", "u", "atp", "livre", "l"]);
const ADULT_GENRES = new Set(["adult", "erotic", "horror", "crime", "thriller", "war"]);
const KIDS_SUPPORT_GENRES = new Set(["adventure", "comedy", "fantasy", "music", "musical"]);

function clean(value) {
  return String(value ?? "").trim();
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
  if (!text) return [...fallback].map(normalizeText).filter(Boolean);
  return text.split(/[;\n\r,]+/g).map(normalizeText).filter(Boolean);
}

function boolEnv(env, name, fallback = false) {
  const value = env?.[name];
  if (value === undefined || value === null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function normalizeRating(value) {
  const text = normalizeText(value)
    .replace(/^rated\s+/, "")
    .replace(/^classification\s+/, "")
    .trim();
  if (!text) return "";
  if (/^tv\s*y\s*7(?:\s*fv)?$/.test(text)) return "tv y7";
  if (/^tv\s*y$/.test(text)) return "tv y";
  if (/^tv\s*g$/.test(text)) return "tv g";
  if (/^tv\s*pg$/.test(text)) return "tv pg";
  if (/^pg\s*13$/.test(text)) return "pg 13";
  return text;
}

function ratingCandidates(meta = {}) {
  const hints = meta?.behaviorHints || {};
  return [
    meta.certification,
    meta.contentRating,
    meta.content_rating,
    meta.ageRating,
    meta.age_rating,
    meta.rated,
    meta.mpaaRating,
    meta.mpaa_rating,
    hints.certification,
    hints.contentRating,
    hints.ageRating
  ].map(normalizeRating).filter(Boolean);
}

function normalizedGenres(meta = {}) {
  return (Array.isArray(meta?.genres) ? meta.genres : [])
    .map(normalizeText)
    .filter(Boolean);
}

function profileCacheKey(resolved = {}) {
  const type = normalizeText(resolved?.type || resolved?.selected?.type || "unknown");
  const id = clean(resolved?.id || resolved?.selected?.id || resolved?.selected?.imdb_id || resolved?.selected?.imdbId);
  return id ? `${type || "unknown"}:${id}` : "";
}

export function classifyAudience(meta = {}, {
  familyEnabled = false,
  familyTitles = [],
  familyGenres = ["family", "kids", "children"],
  kidsTitles = [],
  kidsGenres = ["kids", "children"],
  heuristicEnabled = true,
  cachedProfile = null
} = {}) {
  if (!familyEnabled) return { profile: "default", source: "family_disabled", confidence: 1 };

  if (cachedProfile === "kids" || cachedProfile === "family") {
    return { profile: cachedProfile, source: "semantic_cache", confidence: 1 };
  }

  const title = normalizeText(meta?.name || meta?.title || "");
  const normalizedKidsTitles = kidsTitles.map(normalizeText).filter(Boolean);
  const normalizedFamilyTitles = familyTitles.map(normalizeText).filter(Boolean);
  if (title && normalizedKidsTitles.includes(title)) return { profile: "kids", source: "forced_kids_title", confidence: 1 };
  if (title && normalizedFamilyTitles.includes(title)) return { profile: "family", source: "forced_family_title", confidence: 1 };

  const ratings = ratingCandidates(meta);
  if (ratings.some((rating) => KIDS_RATINGS.has(rating))) {
    return { profile: "kids", source: "content_rating", confidence: 0.99, rating: ratings.find((rating) => KIDS_RATINGS.has(rating)) };
  }
  if (ratings.some((rating) => FAMILY_RATINGS.has(rating))) {
    return { profile: "family", source: "content_rating", confidence: 0.95, rating: ratings.find((rating) => FAMILY_RATINGS.has(rating)) };
  }

  const genres = normalizedGenres(meta);
  const normalizedKidsGenres = kidsGenres.map(normalizeText).filter(Boolean);
  const normalizedFamilyGenres = familyGenres.map(normalizeText).filter(Boolean);
  if (genres.some((genre) => normalizedKidsGenres.includes(genre))) {
    return { profile: "kids", source: "kids_genre", confidence: 0.98 };
  }

  const hasFamilyGenre = genres.some((genre) => normalizedFamilyGenres.includes(genre));
  const hasAnimation = genres.includes("animation");
  if (hasFamilyGenre && hasAnimation) {
    return { profile: "kids", source: "family_animation", confidence: 0.9 };
  }
  if (hasFamilyGenre) return { profile: "family", source: "family_genre", confidence: 0.95 };

  if (heuristicEnabled && hasAnimation && !genres.some((genre) => ADULT_GENRES.has(genre))) {
    const support = genres.filter((genre) => KIDS_SUPPORT_GENRES.has(genre));
    if (support.length >= 2) {
      return { profile: "kids", source: "animation_genre_heuristic", confidence: 0.78, supportGenres: support };
    }
  }

  return { profile: "default", source: "no_family_signal", confidence: 0.8 };
}

function cachePath(env) {
  const root = clean(env?.SOL_PLUGIN_DATA_DIR);
  return root ? join(root, "stremio-audience-cache.json") : "";
}

function loadCache(env) {
  const path = cachePath(env);
  const map = new Map();
  if (!path) return { path, map };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    for (const [key, value] of Object.entries(parsed?.items || {})) {
      if (!key || !value || !["kids", "family"].includes(value.profile)) continue;
      map.set(key, {
        profile: value.profile,
        source: clean(value.source) || "semantic",
        updatedAt: clean(value.updatedAt) || null
      });
    }
  } catch {
    // Missing/corrupt cache is non-fatal; classification continues from metadata.
  }
  return { path, map };
}

function saveCache(runtime) {
  if (!runtime?.cachePath) return;
  try {
    mkdirSync(dirname(runtime.cachePath), { recursive: true });
    const items = Object.fromEntries(runtime.cache.entries());
    const temporary = `${runtime.cachePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, items }, null, 2)}\n`, "utf8");
    renameSync(temporary, runtime.cachePath);
  } catch {
    // Cache persistence must never block playback.
  }
}

function installToolSchemas(tools = []) {
  for (const tool of tools) {
    if (!PROFILE_TOOLS.has(tool?.name)) continue;
    const profile = tool?.inputSchema?.properties?.profile;
    if (!profile) continue;
    profile.enum = ["auto", "default", "kids", "family", "sports"];
    profile.description = "Playback profile. Use kids when the request/title is clearly aimed primarily at children; use family for broad all-ages family entertainment; use sports for sports; use default for normal providers; use auto when uncertain. Explicit kids/family decisions are remembered per Stremio ID, and both use the isolated Spanish/Latin family provider.";
  }
}

async function resolveMetadata(client, args = {}) {
  if (!args.query && !args.id) return null;
  try {
    const resolved = await client.cinemeta.resolve({
      query: args.query,
      id: args.id,
      mediaType: args.mediaType || "auto",
      year: args.year,
      autoPlay: false
    });
    let raw = null;
    try {
      raw = await client.cinemeta.meta(resolved.type, resolved.id);
    } catch {
      raw = resolved.selected || null;
    }
    return {
      resolved,
      meta: {
        ...(raw && typeof raw === "object" ? raw : {}),
        ...(resolved.selected && typeof resolved.selected === "object" ? resolved.selected : {}),
        id: resolved.id,
        type: resolved.type,
        name: resolved.selected?.name || raw?.name || null
      }
    };
  } catch {
    return null;
  }
}

function runtimeFor(client) {
  if (client.__stremioAudienceClassifierRuntime) return client.__stremioAudienceClassifierRuntime;
  const env = client.env || process.env;
  const loaded = loadCache(env);
  const runtime = {
    cache: loaded.map,
    cachePath: loaded.path,
    familyEnabled: boolEnv(env, "HA_SOL_STREMIO_FAMILY_ENABLED", false),
    familyTitles: parseList(env.HA_SOL_STREMIO_FAMILY_TITLES || ""),
    familyGenres: parseList(env.HA_SOL_STREMIO_FAMILY_GENRES || "", ["family", "kids", "children"]),
    kidsTitles: parseList(env.HA_SOL_STREMIO_KIDS_TITLES || ""),
    kidsGenres: parseList(env.HA_SOL_STREMIO_KIDS_GENRES || "", ["kids", "children"]),
    heuristicEnabled: boolEnv(env, "HA_SOL_STREMIO_FAMILY_HEURISTIC_ENABLED", true)
  };
  client.__stremioAudienceClassifierRuntime = runtime;
  return runtime;
}

function remember(runtime, key, profile, source = "semantic_explicit") {
  if (!key || !["kids", "family"].includes(profile)) return;
  runtime.cache.set(key, { profile, source, updatedAt: new Date().toISOString() });
  saveCache(runtime);
}

function addAudienceResult(result, classification, requestedProfile) {
  if (!result || typeof result !== "object") return result;
  return {
    ...result,
    audienceProfile: classification.profile,
    audienceClassification: {
      profile: classification.profile,
      playbackProfile: classification.profile === "kids" ? "family" : classification.profile,
      source: classification.source,
      confidence: classification.confidence ?? null,
      ...(classification.rating ? { rating: classification.rating } : {}),
      requestedProfile
    },
    ...(result.smartPlayback && typeof result.smartPlayback === "object" ? {
      smartPlayback: {
        ...result.smartPlayback,
        audienceProfile: classification.profile,
        audienceSource: classification.source
      }
    } : {})
  };
}

export function installStremioAudienceClassifier(SolPluginClient, tools = []) {
  const proto = SolPluginClient?.prototype;
  if (!proto || proto.__stremioAudienceClassifierInstalled) return SolPluginClient;
  proto.__stremioAudienceClassifierInstalled = true;
  installToolSchemas(tools);

  const originalHandle = proto.handleStremioTool;
  proto.handleStremioTool = async function handleStremioToolWithAudienceClassifier(tool, args = {}) {
    if (!PROFILE_TOOLS.has(tool)) return originalHandle.call(this, tool, args);

    const runtime = runtimeFor(this);
    const requested = clean(args.profile || "auto").toLowerCase();
    if (requested === "sports" || requested === "default") {
      const result = await originalHandle.call(this, tool, { ...args, profile: requested });
      return addAudienceResult(result, { profile: requested, source: "explicit_profile", confidence: 1 }, requested);
    }

    if (tool === "home_assistant_stremio_addons") {
      return originalHandle.call(this, tool, { ...args, profile: requested === "kids" ? "family" : requested });
    }

    let metadata = null;
    if (CLASSIFIABLE_TOOLS.has(tool)) metadata = await resolveMetadata(this, args);
    const key = metadata ? profileCacheKey(metadata.resolved) : "";

    if (requested === "kids" || requested === "family") {
      remember(runtime, key, requested, "semantic_explicit");
      const result = await originalHandle.call(this, tool, { ...args, profile: "family" });
      return addAudienceResult(result, { profile: requested, source: "semantic_explicit", confidence: 1 }, requested);
    }

    const cached = key ? runtime.cache.get(key)?.profile : null;
    const classification = metadata
      ? classifyAudience(metadata.meta, {
          familyEnabled: runtime.familyEnabled,
          familyTitles: runtime.familyTitles,
          familyGenres: runtime.familyGenres,
          kidsTitles: runtime.kidsTitles,
          kidsGenres: runtime.kidsGenres,
          heuristicEnabled: runtime.heuristicEnabled,
          cachedProfile: cached
        })
      : { profile: "default", source: "metadata_unavailable", confidence: 0.5 };

    if (key && ["kids", "family"].includes(classification.profile) && classification.source !== "semantic_cache") {
      remember(runtime, key, classification.profile, classification.source);
    }

    const playbackProfile = classification.profile === "kids" || classification.profile === "family"
      ? "family"
      : "default";
    const result = await originalHandle.call(this, tool, { ...args, profile: playbackProfile });
    return addAudienceResult(result, classification, requested || "auto");
  };

  return SolPluginClient;
}

export const __test = {
  normalizeText,
  normalizeRating,
  ratingCandidates,
  normalizedGenres,
  profileCacheKey,
  parseList
};
