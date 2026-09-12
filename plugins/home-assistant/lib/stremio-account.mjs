import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

const API_BASE = "https://api.strem.io";
const LIBRARY_COLLECTION = "libraryItem";

function clean(value) {
  return String(value ?? "").trim();
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalInt(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function safeAccountId(value) {
  const text = clean(value);
  return text ? `account://${createHash("sha256").update(text).digest("hex").slice(0, 12)}` : null;
}

function resultObject(payload) {
  return payload?.result && typeof payload.result === "object" && !Array.isArray(payload.result)
    ? payload.result
    : payload;
}

function parseLibraryRows(payload) {
  const rows = Array.isArray(payload?.result) ? payload.result : [];
  return rows.filter((item) => item && typeof item === "object" && !Array.isArray(item));
}

function parseEpisodeId(value) {
  const text = clean(value);
  const parts = text.split(":");
  if (parts.length < 3) return null;
  const season = optionalInt(parts.at(-2));
  const episode = optionalInt(parts.at(-1));
  if (season === null || episode === null) return null;
  return { id: text, seriesId: parts.slice(0, -2).join(":"), season, episode };
}

function releaseTime(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : null;
}

function normalizeVideos(meta) {
  return (Array.isArray(meta?.videos) ? meta.videos : [])
    .filter((video) => video && typeof video === "object" && clean(video.id))
    .map((video) => {
      const parsed = parseEpisodeId(video.id);
      return {
        id: clean(video.id),
        season: optionalInt(video.season) ?? parsed?.season ?? null,
        episode: optionalInt(video.episode) ?? parsed?.episode ?? null,
        title: clean(video.title || video.name) || null,
        released: video.released || null,
        overview: video.overview || video.description || null,
        thumbnail: video.thumbnail || null
      };
    });
}

function getBit(bytes, index) {
  if (!Number.isInteger(index) || index < 0) return false;
  const byteIndex = Math.floor(index / 8);
  const bit = index % 8;
  return byteIndex < bytes.length ? ((bytes[byteIndex] >> bit) & 1) !== 0 : false;
}

/** Decode Stremio's watched field: {anchorVideo}:{anchorLength}:{zlib(base64(bitfield))}. */
export function decodeWatchedField(serialized, videoIds) {
  const text = clean(serialized);
  const ids = Array.isArray(videoIds) ? videoIds.map(String) : [];
  if (!text || !ids.length) return ids.map(() => false);
  const components = text.split(":");
  if (components.length < 3) return ids.map(() => false);
  const packed = components.pop();
  const anchorLength = Number(components.pop());
  const anchorVideo = components.join(":");
  if (!packed || !Number.isInteger(anchorLength) || anchorLength < 0 || !anchorVideo) {
    return ids.map(() => false);
  }

  let values;
  try {
    values = inflateSync(Buffer.from(packed, "base64"));
  } catch {
    return ids.map(() => false);
  }
  const anchorIndex = ids.indexOf(anchorVideo);
  if (anchorIndex < 0) return ids.map(() => false);
  const offset = anchorLength - anchorIndex - 1;
  return ids.map((_, index) => getBit(values, index + offset));
}

export function normalizeLibraryItem(item) {
  const rawId = clean(item?._id);
  const type = clean(item?.type || "movie").toLowerCase();
  const mediaId = rawId.includes(":") ? rawId.slice(rawId.indexOf(":") + 1) : rawId;
  const state = item?.state && typeof item.state === "object" ? item.state : {};
  const playbackId = clean(state.video_id || mediaId);
  const parsedEpisode = type === "series" ? parseEpisodeId(playbackId) : null;
  const positionMs = Math.max(0, number(state.timeOffset, state.timeWatched));
  const durationMs = Math.max(0, number(state.duration));
  const progress = durationMs > 0 ? Math.max(0, Math.min(100, (positionMs / durationMs) * 100)) : 0;
  return {
    libraryId: rawId,
    mediaId,
    playbackId,
    type,
    title: clean(item?.name || mediaId) || "Unknown",
    poster: item?.poster || null,
    background: item?.background || null,
    removed: Boolean(item?.removed),
    temp: Boolean(item?.temp),
    positionSeconds: positionMs / 1000,
    durationSeconds: durationMs / 1000,
    progressPercent: Number(progress.toFixed(1)),
    season: optionalInt(state.season) ?? parsedEpisode?.season ?? null,
    episode: optionalInt(state.episode) ?? parsedEpisode?.episode ?? null,
    lastWatched: state.lastWatched || null,
    finished: Boolean(state.flaggedWatched) || (durationMs > 0 && progress >= 90),
    watchedField: clean(state.watched) || null,
    timesWatched: Math.max(0, optionalInt(state.timesWatched) ?? 0)
  };
}

function addonDescriptor(addon) {
  const manifest = addon?.manifest;
  const transportUrl = clean(addon?.transportUrl || addon?.transport_url);
  if (!manifest || typeof manifest !== "object" || !transportUrl) return null;
  const resources = Array.isArray(manifest.resources) ? manifest.resources : [];
  const names = new Set(resources.map((resource) =>
    typeof resource === "string" ? resource : clean(resource?.name)
  ).filter(Boolean));
  const roles = [];
  if (Array.isArray(manifest.catalogs) && manifest.catalogs.length || names.has("catalog") || names.has("meta")) roles.push("catalog");
  if (names.has("stream")) roles.push("stream");
  if (names.has("subtitles")) roles.push("subtitle");
  if (!roles.length) return null;
  return {
    id: clean(manifest.id) || safeAccountId(transportUrl),
    name: clean(manifest.name || manifest.id) || "Account add-on",
    version: clean(manifest.version) || null,
    roles,
    source: safeAccountId(transportUrl),
    transportUrl,
    manifest
  };
}

function safeLibraryItem(item) {
  const { watchedField: _watchedField, ...safe } = item;
  return safe;
}

function releasedEpisodes(videos, now = Date.now()) {
  const regular = videos.filter((video) => Number.isInteger(video.season) && Number.isInteger(video.episode) && video.episode >= 1);
  const nonSpecials = regular.filter((video) => video.season > 0);
  const candidates = nonSpecials.length ? nonSpecials : regular;
  return candidates
    .filter((video) => {
      const released = releaseTime(video.released);
      return released === null || released <= now;
    })
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
}

export function resolveNextEpisodeFromLibrary(meta, libraryItem, { now = Date.now() } = {}) {
  const allVideos = normalizeVideos(meta);
  const candidates = releasedEpisodes(allVideos, now);
  if (!candidates.length) {
    return { status: "no_released_episodes", episode: null, history: null };
  }
  if (!libraryItem) {
    return { status: "first_episode", episode: candidates[0], history: null };
  }

  const videoIds = allVideos.map((video) => video.id);
  const watchedFlags = decodeWatchedField(libraryItem.watchedField, videoIds);
  const watchedById = new Map(videoIds.map((id, index) => [id, Boolean(watchedFlags[index])]));
  const candidateIndexes = new Map(candidates.map((video, index) => [video.id, index]));
  const currentId = clean(libraryItem.playbackId);
  const currentIndex = candidateIndexes.has(currentId) ? candidateIndexes.get(currentId) : -1;
  const currentWatched = currentId ? Boolean(watchedById.get(currentId)) : false;
  const partialCurrent = currentIndex >= 0
    && libraryItem.positionSeconds > 0
    && libraryItem.progressPercent < 90
    && !currentWatched;

  if (partialCurrent) {
    return {
      status: "resume_in_progress",
      episode: candidates[currentIndex],
      history: {
        playbackId: currentId,
        progressPercent: libraryItem.progressPercent,
        watchedBitfieldUsed: Boolean(libraryItem.watchedField)
      }
    };
  }

  let highestWatched = -1;
  for (let index = 0; index < candidates.length; index += 1) {
    if (watchedById.get(candidates[index].id)) highestWatched = index;
  }
  let floor = Math.max(currentIndex, highestWatched);
  if (floor < 0 && libraryItem.season !== null && libraryItem.episode !== null) {
    floor = candidates.findIndex((video) =>
      video.season === libraryItem.season && video.episode === libraryItem.episode
    );
  }

  for (let index = Math.max(0, floor + 1); index < candidates.length; index += 1) {
    if (!watchedById.get(candidates[index].id)) {
      return {
        status: floor >= 0 ? "next_unwatched" : "first_unwatched",
        episode: candidates[index],
        history: {
          playbackId: currentId || null,
          progressPercent: libraryItem.progressPercent,
          highestWatchedIndex: highestWatched,
          watchedBitfieldUsed: Boolean(libraryItem.watchedField)
        }
      };
    }
  }

  if (!libraryItem.watchedField && currentIndex >= 0 && !libraryItem.finished) {
    return {
      status: "resume_current_without_bitfield",
      episode: candidates[currentIndex],
      history: {
        playbackId: currentId,
        progressPercent: libraryItem.progressPercent,
        watchedBitfieldUsed: false
      }
    };
  }

  return {
    status: "caught_up",
    episode: null,
    history: {
      playbackId: currentId || null,
      progressPercent: libraryItem.progressPercent,
      highestWatchedIndex: highestWatched,
      watchedBitfieldUsed: Boolean(libraryItem.watchedField)
    }
  };
}

export class StremioAccountClient {
  constructor({
    enabled = false,
    authKey = "",
    email = "",
    password = "",
    timeoutMs = 12000,
    refreshMs = 60000
  } = {}) {
    this.enabled = Boolean(enabled);
    this.authKey = clean(authKey);
    this.email = clean(email);
    this.password = String(password || "");
    this.timeoutMs = Math.max(1000, Math.min(30000, Number(timeoutMs) || 12000));
    this.refreshMs = Math.max(5000, Math.min(3600000, Number(refreshMs) || 60000));
    this.loadedAt = 0;
    this.user = null;
    this.library = [];
    this.rawAddons = [];
    this.addons = [];
    this.lastError = null;
    this.loginMode = this.authKey ? "auth_key" : (this.email && this.password ? "email_password" : "none");
  }

  get configured() {
    return this.enabled && Boolean(this.authKey || (this.email && this.password));
  }

  async _post(path, data = {}, { authenticated = true } = {}) {
    const payload = { ...data };
    if (authenticated) {
      if (!this.authKey) throw new Error("stremio_account_not_authenticated");
      payload.authKey = this.authKey;
    }
    const response = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 401 || response.status === 403) throw new Error("stremio_account_authentication_failed");
    if (!response.ok) throw new Error(`stremio_account_http_${response.status}`);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("stremio_account_invalid_json");
    return body;
  }

  async ensureAuthenticated() {
    if (!this.enabled) throw new Error("stremio_account_disabled");
    if (this.authKey) return;
    if (!this.email || !this.password) throw new Error("stremio_account_credentials_required");
    const payload = await this._post("/api/login", {
      email: this.email,
      password: this.password,
      facebook: false
    }, { authenticated: false });
    const data = resultObject(payload);
    const authKey = clean(payload.authKey || data?.authKey);
    if (!authKey) throw new Error("stremio_account_login_missing_auth_key");
    this.authKey = authKey;
    this.loginMode = "email_password";
  }

  async refresh({ force = false } = {}) {
    if (!this.configured) throw new Error(this.enabled ? "stremio_account_credentials_required" : "stremio_account_disabled");
    if (!force && this.loadedAt && Date.now() - this.loadedAt < this.refreshMs) return this.snapshot();
    await this.ensureAuthenticated();
    try {
      const [userPayload, libraryPayload, addonsPayload] = await Promise.all([
        this._post("/api/getUser", {}),
        this._post("/api/datastoreGet", { collection: LIBRARY_COLLECTION, all: true, ids: [] }),
        this._post("/api/addonCollectionGet", { update: true })
      ]);
      const user = resultObject(userPayload) || {};
      const rawLibrary = parseLibraryRows(libraryPayload);
      const addonData = resultObject(addonsPayload) || {};
      const rawAddons = Array.isArray(addonsPayload.addons) ? addonsPayload.addons
        : Array.isArray(addonData.addons) ? addonData.addons
          : [];
      this.user = {
        connected: true,
        emailConfigured: Boolean(this.email),
        userId: safeAccountId(user._id || this.email || "connected")
      };
      this.library = rawLibrary
        .map(normalizeLibraryItem)
        .filter((item) => !item.removed);
      this.rawAddons = rawAddons.filter((item) => item && typeof item === "object" && !Array.isArray(item));
      this.addons = this.rawAddons.map(addonDescriptor).filter(Boolean);
      this.loadedAt = Date.now();
      this.lastError = null;
      return this.snapshot();
    } catch (error) {
      this.lastError = error?.message || String(error);
      throw error;
    }
  }

  snapshot() {
    const continueWatching = this.library
      .filter((item) => item.positionSeconds > 0 && !item.finished)
      .sort((a, b) => String(b.lastWatched || "").localeCompare(String(a.lastWatched || "")));
    return {
      enabled: this.enabled,
      configured: this.configured,
      connected: Boolean(this.loadedAt && !this.lastError),
      authMode: this.loginMode,
      loadedAt: this.loadedAt ? new Date(this.loadedAt).toISOString() : null,
      refreshMs: this.refreshMs,
      user: this.user,
      libraryCount: this.library.length,
      continueWatchingCount: continueWatching.length,
      addonCount: this.addons.length,
      streamAddonCount: this.addons.filter((addon) => addon.roles.includes("stream")).length,
      lastError: this.lastError
    };
  }

  safeLibrary({ mediaType = "all", limit = 100 } = {}) {
    const type = clean(mediaType).toLowerCase();
    const rows = type && type !== "all" ? this.library.filter((item) => item.type === type) : this.library;
    return rows.slice(0, Math.max(1, Math.min(500, Number(limit) || 100))).map(safeLibraryItem);
  }

  continueWatching({ mediaType = "all", limit = 50 } = {}) {
    const type = clean(mediaType).toLowerCase();
    return this.library
      .filter((item) => item.positionSeconds > 0 && !item.finished && (type === "all" || !type || item.type === type))
      .sort((a, b) => String(b.lastWatched || "").localeCompare(String(a.lastWatched || "")))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
      .map(safeLibraryItem);
  }

  safeAddons() {
    return this.addons.map((addon) => ({
      id: addon.id,
      name: addon.name,
      version: addon.version,
      roles: addon.roles,
      source: addon.source
    }));
  }

  streamManifestUrls() {
    return [...new Set(this.addons
      .filter((addon) => addon.roles.includes("stream"))
      .map((addon) => addon.transportUrl)
      .filter(Boolean))];
  }

  findSeries(seriesId) {
    const id = clean(seriesId);
    return this.library.find((item) =>
      item.type === "series" && (item.mediaId === id || item.playbackId.split(":").slice(0, -2).join(":") === id)
    ) || null;
  }

  mostRecentSeries() {
    return this.library
      .filter((item) => item.type === "series" && item.lastWatched)
      .sort((a, b) => String(b.lastWatched).localeCompare(String(a.lastWatched)))[0] || null;
  }

  nextEpisode(meta) {
    const seriesId = clean(meta?.id);
    return resolveNextEpisodeFromLibrary(meta, this.findSeries(seriesId));
  }
}
