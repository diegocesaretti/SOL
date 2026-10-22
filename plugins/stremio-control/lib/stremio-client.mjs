import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function normalizeBaseUrl(value) {
  const url = new URL(String(value || "").trim());
  if (!/^https?:$/.test(url.protocol)) throw new Error("stremio_url_must_be_http_or_https");
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export class StremioControlClient {
  constructor({ baseUrl, token, timeoutMs = 8000, dataDir, fetchImpl = fetch }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.configuredToken = token?.trim() || "";
    this.timeoutMs = timeoutMs;
    this.dataDir = dataDir;
    this.fetchImpl = fetchImpl;
    this.pairingFile = path.join(dataDir, "pairing.json");
    this.storedToken = "";
  }

  async initialize() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const payload = JSON.parse(await readFile(this.pairingFile, "utf8"));
      if (typeof payload?.token === "string") this.storedToken = payload.token.trim();
    } catch (error) {
      if (error?.code !== "ENOENT") console.warn(`Stremio pairing state ignored: ${error?.message || error}`);
    }
  }

  get token() {
    return this.configuredToken || this.storedToken;
  }

  get paired() {
    return Boolean(this.token);
  }

  async health() {
    return await this.request("/api/v1/health", { authenticated: false });
  }

  async pair(code, clientName = "SOL") {
    const normalized = String(code || "").trim();
    if (!/^\d{6}$/.test(normalized)) throw new Error("pairing_code_must_be_6_digits");
    const result = await this.request("/api/v1/pair", {
      method: "POST",
      authenticated: false,
      body: { code: normalized, clientName }
    });
    const token = typeof result?.token === "string" ? result.token.trim() : "";
    if (token.length < 32) throw new Error("stremio_pairing_returned_invalid_token");
    this.storedToken = token;
    await writeFile(this.pairingFile, JSON.stringify({ token, pairedAt: new Date().toISOString() }), { encoding: "utf8", mode: 0o600 });
    return { ok: true, paired: true, device: result?.device || null };
  }

  async status() {
    return await this.request("/api/v1/status");
  }

  async playerState() {
    return await this.request("/api/v1/player");
  }

  async search(query, limit = 12) {
    return await this.request("/api/v1/search", {
      method: "POST",
      body: { query, limit }
    });
  }

  async details(type, id) {
    return await this.request("/api/v1/details", {
      method: "POST",
      body: { type, id }
    });
  }

  async play(input) {
    return await this.request("/api/v1/play", { method: "POST", body: input });
  }

  async pause() {
    return await this.request("/api/v1/player/pause", { method: "POST", body: {} });
  }

  async resume() {
    return await this.request("/api/v1/player/resume", { method: "POST", body: {} });
  }

  async seek(input) {
    return await this.request("/api/v1/player/seek", { method: "POST", body: input });
  }

  async selectAudio(id) {
    return await this.request("/api/v1/player/audio", { method: "POST", body: { id } });
  }

  async selectSubtitle(id) {
    return await this.request("/api/v1/player/subtitle", { method: "POST", body: { id } });
  }

  async disableSubtitles() {
    return await this.request("/api/v1/player/subtitle/off", { method: "POST", body: {} });
  }

  async request(route, { method = "GET", body, authenticated = true } = {}) {
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (authenticated) {
      if (!this.token) throw new Error("stremio_not_paired");
      headers.authorization = `Bearer ${this.token}`;
    }
    const response = await this.fetchImpl(`${this.baseUrl}${route}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = typeof payload?.error === "string" ? payload.error : `HTTP_${response.status}`;
      throw new Error(`stremio_api:${reason}`);
    }
    return payload;
  }
}
