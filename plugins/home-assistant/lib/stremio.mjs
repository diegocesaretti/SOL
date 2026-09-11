const DEFAULT_CINEMETA_BASE_URL = "https://v3-cinemeta.strem.io";
const ALLOWED_TYPES = new Set(["movie", "series", "channel", "tv"]);

function nonEmpty(value, name, max = 500) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name}_required`);
  if (text.length > max) throw new Error(`${name}_too_long`);
  return text;
}

function normalizeType(value, { allowAuto = false } = {}) {
  const type = String(value || (allowAuto ? "auto" : "")).trim().toLowerCase();
  if (allowAuto && ["", "auto", "all"].includes(type)) return "auto";
  if (!ALLOWED_TYPES.has(type)) throw new Error("stremio_media_type_invalid");
  return type;
}

function safePathSegment(value, name) {
  const text = nonEmpty(value, name, 300);
  return encodeURIComponent(text).replace(/%3A/gi, ":");
}

function optionalYear(value) {
  if (value === undefined || value === null || value === "") return null;
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1880 || year > 2200) throw new Error("stremio_year_invalid");
  return year;
}

function optionalPositiveInt(value, name) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 10000) throw new Error(`stremio_${name}_invalid`);
  return number;
}

function releaseYear(meta) {
  const raw = String(meta?.releaseInfo || meta?.year || meta?.released || "");
  const match = raw.match(/(?:19|20)\d{2}/);
  return match ? Number(match[0]) : null;
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function scoreMeta(meta, query, year, preferredType) {
  const wanted = normalizeName(query);
  const name = normalizeName(meta?.name);
  let score = 0;
  if (name === wanted) score += 1000;
  else if (name.startsWith(wanted) || wanted.startsWith(name)) score += 600;
  else if (name.includes(wanted) || wanted.includes(name)) score += 350;
  else {
    const wantedTokens = new Set(wanted.split(/\s+/).filter(Boolean));
    const nameTokens = new Set(name.split(/\s+/).filter(Boolean));
    let overlap = 0;
    for (const token of wantedTokens) if (nameTokens.has(token)) overlap += 1;
    score += overlap * 40;
  }
  if (year !== null) {
    const candidateYear = releaseYear(meta);
    if (candidateYear === year) score += 300;
    else if (candidateYear !== null) score -= Math.min(120, Math.abs(candidateYear - year) * 20);
  }
  if (preferredType && preferredType !== "auto" && meta?.type === preferredType) score += 100;
  return score;
}

function compactMeta(meta) {
  if (!meta || typeof meta !== "object") return null;
  return {
    id: meta.id || null,
    type: meta.type || null,
    name: meta.name || null,
    year: releaseYear(meta),
    releaseInfo: meta.releaseInfo || null,
    poster: meta.poster || null,
    description: meta.description || null,
    genres: Array.isArray(meta.genres) ? meta.genres.slice(0, 12) : [],
    imdbRating: meta.imdbRating || null
  };
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`stremio_catalog_http_${response.status}`);
  return await response.json();
}

export function boardDeepLink() {
  return "stremio:///board";
}

export function libraryDeepLink() {
  return "stremio:///library";
}

export function discoverDeepLink() {
  return "stremio:///discover";
}

export function searchDeepLink(query) {
  return `stremio:///search?search=${encodeURIComponent(nonEmpty(query, "stremio_query", 300))}`;
}

export function detailDeepLink({ type, id, videoId = null, autoPlay = false }) {
  const mediaType = normalizeType(type);
  const metaId = safePathSegment(id, "stremio_id");
  const video = videoId ? `/${safePathSegment(videoId, "stremio_video_id")}` : "";
  const autoplay = autoPlay ? "?autoPlay=true" : "";
  return `stremio:///detail/${mediaType}/${metaId}${video}${autoplay}`;
}

export function discoverCatalogDeepLink({ manifestUrl, type, catalogId, genre = null }) {
  const manifest = nonEmpty(manifestUrl, "stremio_manifest_url", 2000);
  let parsed;
  try { parsed = new URL(manifest); } catch { throw new Error("stremio_manifest_url_invalid"); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("stremio_manifest_url_invalid");
  const mediaType = normalizeType(type);
  const id = safePathSegment(catalogId, "stremio_catalog_id");
  const base = `stremio:///discover/${encodeURIComponent(parsed.toString())}/${mediaType}/${id}`;
  return genre ? `${base}?genre=${encodeURIComponent(String(genre))}` : base;
}

export function addonDeepLink(manifestUrl) {
  const manifest = nonEmpty(manifestUrl, "stremio_manifest_url", 2000);
  let parsed;
  try { parsed = new URL(manifest); } catch { throw new Error("stremio_manifest_url_invalid"); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("stremio_manifest_url_invalid");
  const suffix = parsed.toString().replace(/^https?:\/\//i, "");
  return `stremio://${suffix}`;
}

export function isStremioDeepLink(value) {
  return /^stremio:\/\//i.test(String(value || "").trim());
}

export class CinemetaClient {
  constructor({ baseUrl = DEFAULT_CINEMETA_BASE_URL, timeoutMs = 8000 } = {}) {
    this.baseUrl = String(baseUrl || DEFAULT_CINEMETA_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = Math.max(1000, Math.min(30000, Number(timeoutMs) || 8000));
  }

  async search(query, { mediaType = "auto", year = null, limit = 10 } = {}) {
    const q = nonEmpty(query, "stremio_query", 300);
    const type = normalizeType(mediaType, { allowAuto: true });
    const wantedYear = optionalYear(year);
    const types = type === "auto" ? ["movie", "series"] : [type];
    if (types.some((item) => !["movie", "series"].includes(item))) {
      throw new Error("stremio_cinemeta_search_supports_movie_or_series");
    }
    const responses = await Promise.allSettled(types.map(async (item) => {
      const url = `${this.baseUrl}/catalog/${item}/top/search=${encodeURIComponent(q)}.json`;
      const payload = await fetchJson(url, this.timeoutMs);
      return (Array.isArray(payload?.metas) ? payload.metas : []).map((meta) => ({ ...meta, type: meta.type || item }));
    }));
    const metas = responses.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    if (!metas.length && responses.every((result) => result.status === "rejected")) {
      const first = responses.find((result) => result.status === "rejected");
      throw first.reason;
    }
    const deduped = new Map();
    for (const meta of metas) {
      if (!meta?.id) continue;
      const key = `${meta.type || "unknown"}:${meta.id}`;
      if (!deduped.has(key)) deduped.set(key, meta);
    }
    return [...deduped.values()]
      .map((meta) => ({ meta, score: scoreMeta(meta, q, wantedYear, type) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(25, Number(limit) || 10)))
      .map(({ meta, score }) => ({ ...compactMeta(meta), score }));
  }

  async meta(type, id) {
    const mediaType = normalizeType(type);
    if (!["movie", "series"].includes(mediaType)) throw new Error("stremio_cinemeta_meta_supports_movie_or_series");
    const metaId = nonEmpty(id, "stremio_id", 300);
    const payload = await fetchJson(`${this.baseUrl}/meta/${mediaType}/${encodeURIComponent(metaId)}.json`, this.timeoutMs);
    if (!payload?.meta) throw new Error("stremio_meta_not_found");
    return payload.meta;
  }

  async resolve({ query = null, id = null, mediaType = "auto", year = null, season = null, episode = null, autoPlay = true } = {}) {
    const type = normalizeType(mediaType, { allowAuto: true });
    const wantedYear = optionalYear(year);
    const wantedSeason = optionalPositiveInt(season, "season");
    const wantedEpisode = optionalPositiveInt(episode, "episode");
    if ((wantedSeason === null) !== (wantedEpisode === null)) throw new Error("stremio_season_and_episode_required_together");

    let selected;
    if (id) {
      const rawId = nonEmpty(id, "stremio_id", 300);
      if (type === "auto") {
        const candidates = await Promise.allSettled([this.meta("movie", rawId), this.meta("series", rawId)]);
        const movie = candidates[0].status === "fulfilled" ? candidates[0].value : null;
        const series = candidates[1].status === "fulfilled" ? candidates[1].value : null;
        const meta = wantedSeason !== null ? series : (movie || series);
        if (!meta) throw new Error("stremio_meta_not_found");
        selected = { ...meta, type: meta.type || (meta === series ? "series" : "movie") };
      } else {
        selected = await this.meta(type, rawId);
        selected = { ...selected, type: selected.type || type };
      }
    } else {
      const q = nonEmpty(query, "stremio_query", 300);
      const results = await this.search(q, { mediaType: type, year: wantedYear, limit: 8 });
      if (!results.length) throw new Error("stremio_content_not_found");
      const first = results[0];
      selected = await this.meta(first.type, first.id).catch(() => first);
      selected = { ...selected, type: selected.type || first.type, id: selected.id || first.id, name: selected.name || first.name };
    }

    const resolvedType = normalizeType(selected.type);
    const metaId = nonEmpty(selected.id, "stremio_id", 300);
    let videoId = null;
    let video = null;
    let effectiveAutoPlay = Boolean(autoPlay);

    if (resolvedType === "movie") {
      videoId = metaId;
    } else if (resolvedType === "series") {
      if (wantedSeason !== null && wantedEpisode !== null) {
        const videos = Array.isArray(selected.videos) ? selected.videos : [];
        video = videos.find((item) => Number(item?.season) === wantedSeason && Number(item?.episode) === wantedEpisode) || null;
        videoId = video?.id || `${metaId}:${wantedSeason}:${wantedEpisode}`;
      } else {
        effectiveAutoPlay = false;
      }
    } else {
      effectiveAutoPlay = false;
    }

    const deepLink = detailDeepLink({ type: resolvedType, id: metaId, videoId, autoPlay: effectiveAutoPlay && Boolean(videoId) });
    return {
      selected: compactMeta(selected),
      type: resolvedType,
      id: metaId,
      videoId,
      season: wantedSeason,
      episode: wantedEpisode,
      video: video ? {
        id: video.id || videoId,
        title: video.title || null,
        season: Number(video.season),
        episode: Number(video.episode),
        released: video.released || null,
        overview: video.overview || null
      } : null,
      autoPlayRequested: Boolean(autoPlay),
      autoPlayEffective: effectiveAutoPlay && Boolean(videoId),
      deepLink,
      limitation: effectiveAutoPlay && Boolean(videoId)
        ? "Stremio Android TV will attempt autoPlay, but success depends on an already-known stream URL or bingeGroup. Deep links cannot select an exact stream/provider."
        : "Deep link opens the Stremio detail page; exact stream selection is not available through the official deep-link protocol."
    };
  }

  async adjacentEpisode({ query = null, id = null, year = null, currentSeason, currentEpisode, direction = "next", autoPlay = true } = {}) {
    const currentS = optionalPositiveInt(currentSeason, "current_season");
    const currentE = optionalPositiveInt(currentEpisode, "current_episode");
    if (currentS === null || currentE === null) throw new Error("stremio_current_episode_required");
    const resolved = await this.resolve({ query, id, mediaType: "series", year, autoPlay: false });
    const meta = await this.meta("series", resolved.id);
    const videos = (Array.isArray(meta.videos) ? meta.videos : [])
      .filter((item) => Number.isFinite(Number(item?.season)) && Number.isFinite(Number(item?.episode)))
      .sort((a, b) => Number(a.season) - Number(b.season) || Number(a.episode) - Number(b.episode));
    const index = videos.findIndex((item) => Number(item.season) === currentS && Number(item.episode) === currentE);
    if (index < 0) throw new Error("stremio_current_episode_not_found");
    const offset = String(direction).toLowerCase() === "previous" ? -1 : 1;
    const target = videos[index + offset];
    if (!target) throw new Error(offset > 0 ? "stremio_no_next_episode" : "stremio_no_previous_episode");
    const videoId = target.id || `${resolved.id}:${target.season}:${target.episode}`;
    return {
      type: "series",
      id: resolved.id,
      selected: compactMeta(meta),
      season: Number(target.season),
      episode: Number(target.episode),
      videoId,
      video: {
        id: videoId,
        title: target.title || null,
        season: Number(target.season),
        episode: Number(target.episode),
        released: target.released || null,
        overview: target.overview || null
      },
      autoPlayRequested: Boolean(autoPlay),
      autoPlayEffective: Boolean(autoPlay),
      deepLink: detailDeepLink({ type: "series", id: resolved.id, videoId, autoPlay: Boolean(autoPlay) }),
      limitation: "Stremio Android TV will attempt autoPlay, but deep links cannot force an exact stream/provider."
    };
  }
}

export const STREMIO_DEEP_LINK_CAPABILITIES = Object.freeze({
  pages: ["board", "discover", "library"],
  search: true,
  detail: true,
  movie: true,
  seriesEpisode: true,
  adjacentEpisode: true,
  catalog: true,
  addonInstall: true,
  exactStreamSelection: false,
  playerTransport: false,
  androidTvAutoPlay: "best_effort"
});
