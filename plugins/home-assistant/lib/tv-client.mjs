import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { TvNavigationMemory } from "./tv-navigation-memory.mjs";

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

function hamming64(a, b) {
  if (!/^[0-9a-f]{16}$/i.test(String(a || "")) || !/^[0-9a-f]{16}$/i.test(String(b || ""))) return null;
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (x) { count += Number(x & 1n); x >>= 1n; }
  return count;
}

function frameRelation(previous, current) {
  const distance = hamming64(previous, current);
  if (distance === null) return { kind: "unknown", distance: null };
  if (distance <= 2) return { kind: "same", distance };
  if (distance <= 7) return { kind: "similar", distance };
  if (distance <= 15) return { kind: "changed", distance };
  return { kind: "major_change", distance };
}

function collectUiText(node, out, depth = 0) {
  if (!node || typeof node !== "object" || depth > 8 || out.length > 300) return;
  for (const key of ["text", "description", "class", "view_id"]) {
    if (node[key]) out.push(String(node[key]).toLowerCase());
  }
  if (Array.isArray(node.children)) for (const child of node.children) collectUiText(child, out, depth + 1);
}

function classifyUi(observation) {
  const values = [];
  collectUiText(observation?.tree, values);
  const text = values.join(" ");
  const pkg = String(observation?.package || "").toLowerCase();
  const permissionHost = pkg.includes("packageinstaller") || pkg.includes("permissioncontroller") || text.includes("permission") || text.includes("permiso");
  const microphonePermission = permissionHost && ["microphone", "micrófono", "micrófono", "record audio", "grabar audio"].some((s) => text.includes(s));
  const loading = values.some((s) => s.includes("progressbar")) || ["loading", "cargando", "please wait", "espere"].some((s) => text.includes(s));
  const keyboard = text.includes("keyboard") || text.includes("teclado") || Boolean(findEditable(observation?.tree));
  return { permissionDialog: permissionHost, microphonePermission, loading, keyboard };
}

function findEditable(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 8) return false;
  if (node.editable === true) return true;
  return Array.isArray(node.children) && node.children.some((child) => findEditable(child, depth + 1));
}

function visualFocus(observation, screenshot) {
  const focus = observation?.focus_hint || observation?.focused;
  if (!focus) return null;
  const contrast = Number(screenshot?.focusContrast);
  const accessibilityConfidence = Number(focus.confidence ?? 0.82);
  const visualBonus = Number.isFinite(contrast) && contrast >= 0 ? Math.min(0.16, contrast * 0.28) : 0;
  return {
    text: focus.text || null,
    description: focus.description || null,
    bounds: focus.bounds_normalized || focus.bounds || null,
    center: focus.center_normalized || null,
    selected: Boolean(focus.selected),
    source: Number.isFinite(contrast) && contrast >= 0 ? "accessibility+visual_border" : "accessibility",
    borderContrast: Number.isFinite(contrast) ? contrast : null,
    confidence: Math.min(0.99, accessibilityConfidence + visualBonus)
  };
}

const memoryPath = join(process.env.SOL_PLUGIN_DATA_DIR || new URL("../.data", import.meta.url).pathname, "tv-navigation-memory.json");
const navigationMemory = new TvNavigationMemory(memoryPath);
const navigationMemoryReady = navigationMemory.load();

export class TvSatelliteClient {
  constructor({ enabled = false, baseUrl = "", timeoutMs = 8000 } = {}) {
    this.enabled = Boolean(enabled);
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.timeoutMs = Math.max(1000, Math.min(30000, Number(timeoutMs) || 8000));
    this.sessionId = null;
    this.sessionExpiresAt = 0;
    this.lastObservation = null;
    this.lastDHash = null;
    this.cachedObservation = null;
    this.cachedScreenshot = null;
    this.cacheExpiresAt = 0;
    this.pendingDirection = null;
    this.pendingBeforeObservation = null;
    this.androidApi = null;
  }

  get configured() { return this.enabled && Boolean(this.baseUrl); }
  get sessionActive() { return Boolean(this.sessionId) && Date.now() < this.sessionExpiresAt; }

  summary() {
    return {
      enabled: this.enabled,
      configured: this.configured,
      baseUrl: this.baseUrl || null,
      authentication: "none",
      controlSession: this.sessionActive ? { id: this.sessionId, expiresInMs: this.sessionExpiresAt - Date.now() } : null,
      captureMode: "on_demand"
    };
  }

  assertConfigured() {
    if (!this.enabled) throw new Error("tv_satellite_disabled");
    if (!this.baseUrl) throw new Error("tv_satellite_url_required");
  }

  ensureSession() {
    if (!this.sessionActive) this.sessionId = randomUUID();
    this.sessionExpiresAt = Date.now() + 60_000;
    return this.sessionId;
  }

  cachePostAction(observation, screenshot) {
    this.cachedObservation = observation || null;
    this.cachedScreenshot = screenshot || null;
    this.cacheExpiresAt = Date.now() + 1800;
  }

  clearExpiredCache() {
    if (Date.now() <= this.cacheExpiresAt) return;
    this.cachedObservation = null;
    this.cachedScreenshot = null;
  }

  async health() {
    if (!this.enabled || !this.baseUrl) return { ...this.summary(), reachable: false };
    try {
      const response = await fetch(`${this.baseUrl}/health`, { method: "GET", signal: AbortSignal.timeout(this.timeoutMs) });
      const payload = await payloadOrText(response);
      if (Number.isFinite(Number(payload?.android_api))) this.androidApi = Number(payload.android_api);
      return { ...this.summary(), reachable: response.ok, status: response.status, satellite: payload };
    } catch (error) {
      return { ...this.summary(), reachable: false, error: error?.message || String(error) };
    }
  }

  async decorateObservation(payload, screenshot = null) {
    await navigationMemoryReady;
    const relation = screenshot?.dHash ? frameRelation(this.lastDHash, screenshot.dHash) : { kind: "unknown", distance: null };
    const decorated = {
      ...payload,
      visual_focus: visualFocus(payload, screenshot),
      ui_state: classifyUi(payload),
      frame_perceptual: relation,
      learned_navigation: navigationMemory.current(payload),
      control_session: {
        active: this.sessionActive,
        id: this.sessionActive ? this.sessionId : null,
        expires_in_ms: this.sessionActive ? this.sessionExpiresAt - Date.now() : 0
      },
      navigation_strategy: {
        mode: "computer_use_tv",
        stable_layout: "Calculate DPAD distance from the highlighted element and batch deterministic movement.",
        adaptive_precision: "For a long route, execute the coarse portion first and leave the final 1-2 moves for a verification checkpoint when target focus is uncertain.",
        keyboard: "Treat the highlighted key as the origin; calculate row/column displacement and batch the shortest deterministic path.",
        recovery: "If the frame is unchanged or focus is unexpected, re-plan from actual focus instead of repeating blindly."
      }
    };
    if (screenshot?.dHash) this.lastDHash = screenshot.dHash;
    return decorated;
  }

  async _fetchObservation({ sinceSequence = null, waitMs = 0 } = {}) {
    const url = new URL(`${this.baseUrl}/observe`);
    if (Number.isFinite(Number(sinceSequence))) url.searchParams.set("since_sequence", String(Math.trunc(Number(sinceSequence))));
    if (Number(waitMs) > 0) url.searchParams.set("wait_ms", String(Math.max(0, Math.min(5000, Math.trunc(Number(waitMs))))));
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(Math.max(this.timeoutMs, Number(waitMs) + 1000)) });
    const payload = await payloadOrText(response);
    if (!response.ok) throw new Error(`tv_satellite_observe_failed:${payload?.error || `HTTP_${response.status}`}`);
    return payload;
  }

  async observe({ sinceSequence = null, waitMs = null } = {}) {
    this.assertConfigured();
    this.clearExpiredCache();
    if (this.cachedObservation) return this.cachedObservation;
    const previous = this.lastObservation;
    const seq = sinceSequence ?? previous?.ui_event_sequence ?? null;
    const effectiveWait = waitMs ?? (this.sessionActive && previous ? 500 : 0);
    const raw = await this._fetchObservation({ sinceSequence: seq, waitMs: effectiveWait });

    if (this.pendingDirection && this.pendingBeforeObservation) {
      await navigationMemoryReady;
      navigationMemory.record({ before: this.pendingBeforeObservation, after: raw, direction: this.pendingDirection });
      this.pendingDirection = null;
      this.pendingBeforeObservation = null;
    }

    const decorated = await this.decorateObservation(raw, null);
    this.lastObservation = decorated;
    return decorated;
  }

  async _fetchScreenshot(profile = "full") {
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

  async screenshot({ profile = "full" } = {}) {
    this.assertConfigured();
    this.clearExpiredCache();
    if (this.cachedScreenshot) return this.cachedScreenshot;
    const screenshot = await this._fetchScreenshot(profile);
    if (screenshot.dHash) this.lastDHash = screenshot.dHash;
    return screenshot;
  }

  async _legacyAction(action, data = {}) {
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

  async action(action, data = {}) {
    this.assertConfigured();
    const sessionId = this.ensureSession();
    const before = this.lastObservation;
    try {
      let executed = await this.execute({
        actions: [{ action, ...data }],
        sessionId,
        screenshot: true,
        screenshotProfile: "preview",
        quietMs: 130,
        waitTimeoutMs: 1300,
        gapMs: 60
      });
      const first = executed?.actions?.[0] || { ok: executed?.ok === true, action };
      if (!first.ok) {
        if (first.fallback === "home_assistant" && action.startsWith("dpad_")) {
          this.pendingDirection = action.replace(/^dpad_/, "").replace("center", "center");
          this.pendingBeforeObservation = before;
          this.cachedObservation = null;
          this.cachedScreenshot = null;
          return { httpStatus: 409, ...first };
        }
        return { httpStatus: 409, ...first };
      }

      let observation = executed.observation || null;
      let screenshot = executed.screenshot || null;
      let state = classifyUi(observation);

      // Safe automatic recovery: dismiss unrelated Android microphone permission dialogs.
      if (state.microphonePermission && action !== "back") {
        const recovered = await this.execute({ actions: [{ action: "back" }], sessionId, screenshot: true, screenshotProfile: "preview", quietMs: 130, waitTimeoutMs: 1200 });
        if (recovered?.observation) {
          executed = { ...recovered, recovery: { performed: true, reason: "unrelated_microphone_permission", action: "back" } };
          observation = recovered.observation;
          screenshot = recovered.screenshot;
          state = classifyUi(observation);
        }
      }

      // Loading recovery: wait for UI event quietness once rather than returning a transitional frame.
      if (state.loading) {
        const settled = await this.execute({ actions: [], sessionId, screenshot: true, screenshotProfile: "preview", quietMs: 180, waitTimeoutMs: 1400 });
        if (settled?.observation) {
          executed = { ...settled, recovery: { performed: true, reason: "loading_wait" } };
          observation = settled.observation;
          screenshot = settled.screenshot;
        }
      }

      const relation = screenshot?.dHash ? frameRelation(this.lastDHash, screenshot.dHash) : { kind: "unknown", distance: null };
      if (screenshot && relation.kind === "major_change") {
        // Progressive capture: preview was enough to detect the transition; now get detail only because the screen changed materially.
        screenshot = await this._fetchScreenshot("full");
      }

      const decorated = observation ? await this.decorateObservation(observation, screenshot) : null;
      if (before && decorated && action.startsWith("dpad_")) {
        await navigationMemoryReady;
        navigationMemory.record({ before, after: decorated, direction: action.replace(/^dpad_/, "") });
      }
      if (decorated) this.lastObservation = decorated;
      if (screenshot) this.cachePostAction(decorated, screenshot);
      return { httpStatus: 200, ...first, sessionId, recovery: executed.recovery || null, settle: executed.settle || null };
    } catch (error) {
      if (String(error?.message || error).includes("tv_satellite_execute_failed")) return this._legacyAction(action, data);
      throw error;
    }
  }

  async execute({ actions = [], sessionId = "", screenshot = true, screenshotProfile = "preview", quietMs = 140, waitTimeoutMs = 1500, gapMs = 70 } = {}) {
    this.assertConfigured();
    const response = await fetch(`${this.baseUrl}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actions, session_id: sessionId, screenshot, screenshot_profile: screenshotProfile, quiet_ms: quietMs, wait_timeout_ms: waitTimeoutMs, gap_ms: gapMs }),
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
