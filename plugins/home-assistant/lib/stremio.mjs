const DEFAULT_CINEMETA_BASE_URL = "https://v3-cinemeta.strem.io";
const ALLOWED_TYPES = new Set(["movie", "series"]);

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
  return encodeURIComponent(nonEmpty(value, name, 300)).replace(/%3A/gi, ":");
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
  const match = String(meta?.releaseInfo || meta?.year || meta?.released || "").match(/(?:19|20)\d{2}/);
  return match ? Number(match[0]) : null;
}

function normalizeName(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
    for (const token of wantedTokens) if (nameTokens.has(token)) score += 40;
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
  const response = await fetch(url, { headers: { accept: "application/json" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`stremio_catalog_http_${response.status}`);
  return response.json();
}

export function boardDeepLink() { return "stremio:///board"; }
export function libraryDeepLink() { return "stremio:///library"; }
export function discoverDeepLink() { return "stremio:///discover"; }
export function searchDeepLink(query) { return `stremio:///search?search=${encodeURIComponent(nonEmpty(query, "stremio_query", 300))}`; }

export function detailDeepLink({ type, id, videoId = null, autoPlay = false }) {
  const mediaType = normalizeType(type);
  const metaId = safePathSegment(id, "stremio_id");
  const video = videoId ? `/${safePathSegment(videoId, "stremio_video_id")}` : "";
  return `stremio:///detail/${mediaType}/${metaId}${video}${autoPlay ? "?autoPlay=true" : ""}`;
}

export function isStremioDeepLink(value) { return /^stremio:\/\//i.test(String(value || "").trim()); }

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
    const responses = await Promise.allSettled(types.map(async (item) => {
      const payload = await fetchJson(`${this.baseUrl}/catalog/${item}/top/search=${encodeURIComponent(q)}.json`, this.timeoutMs);
      return (Array.isArray(payload?.metas) ? payload.metas : []).map((meta) => ({ ...meta, type: meta.type || item }));
    }));
    const metas = responses.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    if (!metas.length && responses.every((result) => result.status === "rejected")) throw responses.find((result) => result.status === "rejected").reason;
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
    const payload = await fetchJson(`${this.baseUrl}/meta/${mediaType}/${encodeURIComponent(nonEmpty(id, "stremio_id", 300))}.json`, this.timeoutMs);
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
    } else if (wantedSeason !== null && wantedEpisode !== null) {
      const videos = Array.isArray(selected.videos) ? selected.videos : [];
      video = videos.find((item) => Number(item?.season) === wantedSeason && Number(item?.episode) === wantedEpisode) || null;
      videoId = video?.id || `${metaId}:${wantedSeason}:${wantedEpisode}`;
    } else {
      effectiveAutoPlay = false;
    }

    return {
      selected: compactMeta(selected),
      type: resolvedType,
      id: metaId,
      videoId,
      season: wantedSeason,
      episode: wantedEpisode,
      video: video ? { id: video.id || videoId, title: video.title || null, season: Number(video.season), episode: Number(video.episode), released: video.released || null, overview: video.overview || null } : null,
      autoPlayRequested: Boolean(autoPlay),
      autoPlayEffective: effectiveAutoPlay && Boolean(videoId),
      deepLink: detailDeepLink({ type: resolvedType, id: metaId, videoId, autoPlay: effectiveAutoPlay && Boolean(videoId) })
    };
  }
}
