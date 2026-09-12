import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { detailDeepLink } from "./stremio.mjs";

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET, OPTIONS");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload));
}

function normalizePublicOrigin(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  let url;
  try { url = new URL(text); } catch { throw new Error("stremio_proxy_public_url_invalid"); }
  if (url.protocol !== "https:") throw new Error("stremio_proxy_public_url_must_use_https");
  if (url.username || url.password || url.search || url.hash) throw new Error("stremio_proxy_public_url_invalid");
  if (url.pathname && url.pathname !== "/") throw new Error("stremio_proxy_public_url_must_be_origin_only");
  return url.origin;
}

function safeToken(value) {
  const token = String(value || "").trim();
  if (!token) return "";
  if (!/^[A-Za-z0-9_-]{12,160}$/.test(token)) throw new Error("stremio_proxy_token_invalid");
  return token;
}

function customMetaId(sessionId, type, id) {
  return `sol:${sessionId}:${type}:${id}`;
}

function customVideoId(sessionId, type, id, season, episode) {
  if (type === "movie") return customMetaId(sessionId, type, id);
  return `${customMetaId(sessionId, type, id)}:${season}:${episode}`;
}

function cloneStreamForSol(entry) {
  const raw = structuredClone(entry.stream || {});
  const details = entry.details || {};
  const quality = details.quality ? `${details.quality}p` : "Auto";
  const language = Array.isArray(details.languages) && details.languages.length ? details.languages.join("/") : "audio ?";
  const addonName = entry.addon?.name || "provider";
  const originalName = raw.name ? String(raw.name) : "";
  const originalTitle = raw.title ? String(raw.title) : "";
  raw.name = `SOL · ${quality}`;
  raw.title = [quality, language, addonName, originalName, originalTitle].filter(Boolean).join(" · ").slice(0, 500);
  raw.behaviorHints = {
    ...(raw.behaviorHints && typeof raw.behaviorHints === "object" ? raw.behaviorHints : {}),
    bingeGroup: raw.behaviorHints?.bingeGroup
      || `sol-${String(entry.addon?.id || "addon").replace(/[^A-Za-z0-9._-]/g, "-")}-${details.quality || "auto"}-${details.languages?.[0] || "any"}`
  };
  return raw;
}

export class StremioSelectorProxy {
  constructor({
    aggregator,
    cinemeta,
    enabled = false,
    port = 8770,
    publicUrl = "",
    token = "",
    sessionTtlMs = 6 * 60 * 60 * 1000
  } = {}) {
    this.aggregator = aggregator;
    this.cinemeta = cinemeta;
    this.enabled = Boolean(enabled);
    this.port = Math.max(1024, Math.min(65535, Number(port) || 8770));
    this.publicOrigin = normalizePublicOrigin(publicUrl);
    this.token = safeToken(token);
    this.sessionTtlMs = Math.max(10 * 60 * 1000, Number(sessionTtlMs) || 6 * 60 * 60 * 1000);
    this.sessions = new Map();
    this.server = null;
    this.started = false;
  }

  get readyForInstall() {
    return this.enabled && Boolean(this.publicOrigin && this.token);
  }

  manifestUrl() {
    if (!this.readyForInstall) return null;
    return `${this.publicOrigin}/${this.token}/manifest.json`;
  }

  installDeepLink() {
    const manifest = this.manifestUrl();
    return manifest ? `stremio://${manifest.replace(/^https:\/\//i, "")}` : null;
  }

  manifest() {
    return {
      id: "com.sol.stream-selector",
      version: "0.3.6",
      name: "SOL Stream Selector",
      description: "Selects one ranked stream from user-configured Stremio addons for SOL.",
      resources: [
        { name: "meta", types: ["movie", "series"], idPrefixes: ["sol:"] },
        { name: "stream", types: ["movie", "series"], idPrefixes: ["sol:"] }
      ],
      types: ["movie", "series"],
      idPrefixes: ["sol:"],
      catalogs: [],
      behaviorHints: { p2p: true }
    };
  }

  cleanupSessions() {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }

  createSession({ type, id, preferences = {} }) {
    if (!this.readyForInstall) throw new Error("stremio_proxy_not_configured");
    this.cleanupSessions();
    const sessionId = randomBytes(9).toString("base64url");
    const session = {
      sessionId,
      type,
      id,
      preferences: { ...preferences },
      createdAt: Date.now(),
      expiresAt: Date.now() + this.sessionTtlMs
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  buildSelectionDeepLink({ type, id, season = null, episode = null, preferences = {}, autoPlay = true }) {
    const session = this.createSession({ type, id, preferences });
    const metaId = customMetaId(session.sessionId, type, id);
    const videoId = type === "movie"
      ? metaId
      : (season !== null && episode !== null ? customVideoId(session.sessionId, type, id, season, episode) : null);
    return {
      sessionId: session.sessionId,
      metaId,
      videoId,
      deepLink: detailDeepLink({ type, id: metaId, videoId, autoPlay: Boolean(autoPlay && videoId) })
    };
  }

  parseCustomId(value) {
    const text = decodeURIComponent(String(value || ""));
    const match = text.match(/^sol:([A-Za-z0-9_-]+):(movie|series):(.+)$/);
    if (!match) return null;
    const session = this.sessions.get(match[1]);
    if (!session || session.expiresAt <= Date.now()) return null;
    const prefix = customMetaId(session.sessionId, session.type, session.id);
    if (!text.startsWith(prefix)) return null;
    if (session.type === "movie") {
      if (text !== prefix) return null;
      return { session, metaId: prefix, originalVideoId: session.id, season: null, episode: null };
    }
    if (text === prefix) return { session, metaId: prefix, originalVideoId: null, season: null, episode: null };
    const tail = text.slice(prefix.length + 1);
    const episodeMatch = tail.match(/^(\d+):(\d+)$/);
    if (!episodeMatch) return null;
    const season = Number(episodeMatch[1]);
    const episode = Number(episodeMatch[2]);
    return {
      session,
      metaId: prefix,
      originalVideoId: `${session.id}:${season}:${episode}`,
      season,
      episode
    };
  }

  async metaResponse(type, customId) {
    const parsed = this.parseCustomId(customId);
    if (!parsed || parsed.session.type !== type || parsed.originalVideoId) return { meta: null };
    const source = await this.cinemeta.meta(type, parsed.session.id);
    const meta = structuredClone(source);
    meta.id = parsed.metaId;
    if (type === "series" && Array.isArray(meta.videos)) {
      meta.videos = meta.videos.map((video) => {
        const season = Number(video?.season);
        const episode = Number(video?.episode);
        if (!Number.isFinite(season) || !Number.isFinite(episode)) return video;
        return {
          ...video,
          id: customVideoId(parsed.session.sessionId, type, parsed.session.id, season, episode)
        };
      });
    }
    return { meta };
  }

  async streamResponse(type, customId) {
    const parsed = this.parseCustomId(customId);
    if (!parsed || parsed.session.type !== type || !parsed.originalVideoId) return { streams: [] };
    const selection = await this.aggregator.selectStream(type, parsed.originalVideoId, parsed.session.preferences);
    if (!selection.selected) return { streams: [] };
    return { streams: [cloneStreamForSol(selection.selected)] };
  }

  async ensureStarted() {
    if (!this.enabled) return { enabled: false };
    if (!this.readyForInstall) throw new Error(!this.publicOrigin ? "stremio_proxy_public_url_required" : "stremio_proxy_token_required");
    if (this.started && this.server) return this.status();

    this.server = createServer(async (request, response) => {
      try {
        if (request.method === "OPTIONS") {
          response.statusCode = 204;
          response.setHeader("access-control-allow-origin", "*");
          response.setHeader("access-control-allow-methods", "GET, OPTIONS");
          response.end();
          return;
        }
        if (request.method !== "GET") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        const url = new URL(request.url || "/", "http://127.0.0.1");
        const base = `/${this.token}`;
        if (url.pathname === `${base}/manifest.json`) {
          sendJson(response, 200, this.manifest());
          return;
        }
        const metaMatch = url.pathname.match(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/meta/(movie|series)/(.+)\\.json$`));
        if (metaMatch) {
          sendJson(response, 200, await this.metaResponse(metaMatch[1], metaMatch[2]));
          return;
        }
        const streamMatch = url.pathname.match(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/stream/(movie|series)/(.+)\\.json$`));
        if (streamMatch) {
          sendJson(response, 200, await this.streamResponse(streamMatch[1], streamMatch[2]));
          return;
        }
        if (url.pathname === `${base}/`) {
          sendJson(response, 200, { ok: true, name: "SOL Stream Selector", manifest: this.manifestUrl() });
          return;
        }
        sendJson(response, 404, { error: "not_found" });
      } catch (error) {
        sendJson(response, 500, { error: error?.message || String(error) });
      }
    });

    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(this.port, "0.0.0.0", () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    this.server.unref?.();
    this.started = true;
    return this.status();
  }

  status() {
    return {
      enabled: this.enabled,
      started: this.started,
      port: this.port,
      bind: this.enabled ? "0.0.0.0" : null,
      readyForInstall: this.readyForInstall,
      publicOrigin: this.publicOrigin || null,
      manifestUrl: this.manifestUrl(),
      installDeepLink: this.installDeepLink(),
      activeSessions: [...this.sessions.values()].filter((session) => session.expiresAt > Date.now()).length,
      requirement: "Remote Stremio addons must be reachable over trusted HTTPS; expose this local port through an HTTPS reverse proxy/tunnel before installing it on Android TV."
    };
  }
}
