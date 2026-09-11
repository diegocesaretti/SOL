function normalizeBaseUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  let url;
  try { url = new URL(text); } catch { throw new Error("tv_satellite_url_invalid"); }
  if (url.protocol !== "http:") throw new Error("tv_satellite_url_must_use_http");
  if (url.username || url.password || url.search || url.hash) throw new Error("tv_satellite_url_invalid");
  return url.toString().replace(/\/$/, "");
}

async function payloadOrText(response) {
  const type = response.headers.get("content-type") || "";
  if (type.includes("application/json")) return await response.json().catch(() => ({}));
  return { error: (await response.text().catch(() => "")).slice(0, 500) || `HTTP ${response.status}` };
}

export class TvSatelliteClient {
  constructor({ enabled = false, baseUrl = "", timeoutMs = 8000 } = {}) {
    this.enabled = Boolean(enabled);
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.timeoutMs = Math.max(1000, Math.min(30000, Number(timeoutMs) || 8000));
  }

  get configured() {
    return this.enabled && Boolean(this.baseUrl);
  }

  summary() {
    return {
      enabled: this.enabled,
      configured: this.configured,
      baseUrl: this.baseUrl || null,
      authentication: "none"
    };
  }

  assertConfigured() {
    if (!this.enabled) throw new Error("tv_satellite_disabled");
    if (!this.baseUrl) throw new Error("tv_satellite_url_required");
  }

  async health() {
    if (!this.enabled || !this.baseUrl) return { ...this.summary(), reachable: false };
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      const payload = await payloadOrText(response);
      return {
        ...this.summary(),
        reachable: response.ok,
        status: response.status,
        satellite: payload
      };
    } catch (error) {
      return {
        ...this.summary(),
        reachable: false,
        error: error?.message || String(error)
      };
    }
  }

  async observe() {
    this.assertConfigured();
    const response = await fetch(`${this.baseUrl}/observe`, {
      method: "GET",
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const payload = await payloadOrText(response);
    if (!response.ok) throw new Error(`tv_satellite_observe_failed:${payload?.error || `HTTP_${response.status}`}`);
    return payload;
  }

  async screenshot() {
    this.assertConfigured();
    const response = await fetch(`${this.baseUrl}/screenshot`, {
      method: "GET",
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) {
      const payload = await payloadOrText(response);
      throw new Error(`tv_satellite_screenshot_failed:${payload?.error || `HTTP_${response.status}`}`);
    }
    const contentType = (response.headers.get("content-type") || "image/jpeg").split(";", 1)[0].trim().toLowerCase();
    if (!/^image\/(jpeg|png|webp)$/.test(contentType)) throw new Error("tv_satellite_screenshot_invalid_content_type");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error("tv_satellite_screenshot_empty");
    if (buffer.length > 8 * 1024 * 1024) throw new Error("tv_satellite_screenshot_too_large");
    return { buffer, contentType };
  }

  async action(action, data = {}) {
    this.assertConfigured();
    const response = await fetch(`${this.baseUrl}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...data }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const payload = await payloadOrText(response);
    if (!response.ok && response.status !== 409) {
      throw new Error(`tv_satellite_action_failed:${payload?.error || `HTTP_${response.status}`}`);
    }
    return { httpStatus: response.status, ...payload };
  }
}
