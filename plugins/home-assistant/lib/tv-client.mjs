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

function safeBufferFromBase64(value) {
  if (!value || typeof value !== "string") return null;
  const buffer = Buffer.from(value, "base64");
  if (!buffer.length) return null;
  if (buffer.length > 8 * 1024 * 1024) throw new Error("tv_satellite_screenshot_too_large");
  return buffer;
}

export class TvSatelliteClient {
  constructor({ enabled = false, baseUrl = "", timeoutMs = 8000 } = {}) {
    this.enabled = Boolean(enabled);
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.timeoutMs = Math.max(1000, Math.min(30000, Number(timeoutMs) || 8000));
  }

  get configured() { return this.enabled && Boolean(this.baseUrl); }

  summary() {
    return { enabled: this.enabled, configured: this.configured, baseUrl: this.baseUrl || null, authentication: "none" };
  }

  assertConfigured() {
    if (!this.enabled) throw new Error("tv_satellite_disabled");
    if (!this.baseUrl) throw new Error("tv_satellite_url_required");
  }

  async health() {
    if (!this.enabled || !this.baseUrl) return { ...this.summary(), reachable: false };
    try {
      const response = await fetch(`${this.baseUrl}/health`, { method: "GET", signal: AbortSignal.timeout(this.timeoutMs) });
      const payload = await payloadOrText(response);
      return { ...this.summary(), reachable: response.ok, status: response.status, satellite: payload };
    } catch (error) {
      return { ...this.summary(), reachable: false, error: error?.message || String(error) };
    }
  }

  async observe({ sinceSequence = null, waitMs = 0 } = {}) {
    this.assertConfigured();
    const url = new URL(`${this.baseUrl}/observe`);
    if (Number.isFinite(Number(sinceSequence))) url.searchParams.set("since_sequence", String(Math.trunc(Number(sinceSequence))));
    if (Number(waitMs) > 0) url.searchParams.set("wait_ms", String(Math.max(0, Math.min(5000, Math.trunc(Number(waitMs))))));
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(Math.max(this.timeoutMs, Number(waitMs) + 1000)) });
    const payload = await payloadOrText(response);
    if (!response.ok) throw new Error(`tv_satellite_observe_failed:${payload?.error || `HTTP_${response.status}`}`);
    return payload;
  }

  async screenshot({ profile = "full" } = {}) {
    this.assertConfigured();
    const normalizedProfile = ["preview", "focus", "full"].includes(String(profile)) ? String(profile) : "full";
    const url = new URL(`${this.baseUrl}/screenshot`);
    url.searchParams.set("profile", normalizedProfile);
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) {
      const payload = await payloadOrText(response);
      throw new Error(`tv_satellite_screenshot_failed:${payload?.error || `HTTP_${response.status}`}`);
    }
    const contentType = (response.headers.get("content-type") || "image/jpeg").split(";", 1)[0].trim().toLowerCase();
    if (!/^image\/(jpeg|png|webp)$/.test(contentType)) throw new Error("tv_satellite_screenshot_invalid_content_type");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error("tv_satellite_screenshot_empty");
    if (buffer.length > 8 * 1024 * 1024) throw new Error("tv_satellite_screenshot_too_large");
    return {
      buffer,
      contentType,
      dHash: response.headers.get("x-codex-dhash") || null,
      profile: response.headers.get("x-codex-profile") || normalizedProfile,
      focusContrast: Number(response.headers.get("x-codex-focus-contrast")),
      uiSequence: Number(response.headers.get("x-codex-ui-sequence"))
    };
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
    if (!response.ok && response.status !== 409) throw new Error(`tv_satellite_action_failed:${payload?.error || `HTTP_${response.status}`}`);
    return { httpStatus: response.status, ...payload };
  }

  async execute({ actions = [], sessionId = "", screenshot = true, screenshotProfile = "preview", quietMs = 140, waitTimeoutMs = 1500, gapMs = 70 } = {}) {
    this.assertConfigured();
    const response = await fetch(`${this.baseUrl}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actions,
        session_id: sessionId,
        screenshot,
        screenshot_profile: screenshotProfile,
        quiet_ms: quietMs,
        wait_timeout_ms: waitTimeoutMs,
        gap_ms: gapMs
      }),
      signal: AbortSignal.timeout(Math.max(this.timeoutMs, Number(waitTimeoutMs) + 3500))
    });
    const payload = await payloadOrText(response);
    if (!response.ok) throw new Error(`tv_satellite_execute_failed:${payload?.error || `HTTP_${response.status}`}`);
    const buffer = safeBufferFromBase64(payload?.screenshot_b64);
    if (payload && Object.prototype.hasOwnProperty.call(payload, "screenshot_b64")) delete payload.screenshot_b64;
    return {
      ...payload,
      screenshot: buffer ? {
        buffer,
        contentType: payload?.screenshot_content_type || "image/jpeg",
        dHash: payload?.frame_dhash || null,
        profile: payload?.screenshot_profile || screenshotProfile,
        width: payload?.screenshot_width || null,
        height: payload?.screenshot_height || null,
        focusContrast: Number(payload?.focus_contrast)
      } : null
    };
  }
}
