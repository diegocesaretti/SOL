import {
  STREMIO_MCP_TOOLS,
  SolPluginClient as CoreSolPluginClient
} from "./sol-client-core.mjs";

export { STREMIO_MCP_TOOLS };

function boolEnv(env, name, fallback = false) {
  const value = env[name];
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function numberEnv(env, name, fallback, min, max) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTvUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  let url;
  try { url = new URL(text); } catch { return ""; }
  if (url.protocol !== "http:") return "";
  return url.toString().replace(/\/$/, "");
}

function uniqueTextCandidates(selected) {
  const raw = [selected?.title, selected?.name, selected?.addonName]
    .filter((value) => typeof value === "string" && value.trim())
    .flatMap((value) => {
      const text = value.trim();
      const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
      return [text, firstLine];
    });
  const seen = new Set();
  const result = [];
  for (const value of raw) {
    const clean = value.replace(/\s+/g, " ").trim();
    if (clean.length < 3) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(clean.slice(0, 240));
  }
  return result;
}

async function responsePayload(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return await response.json().catch(() => ({}));
  return { text: (await response.text().catch(() => "")).slice(0, 500) };
}

export class SolPluginClient extends CoreSolPluginClient {
  constructor(env = process.env) {
    super(env);
    this.stremioAutoSelectStream = boolEnv(env, "HA_SOL_STREMIO_AUTOSELECT_STREAM", true);
    this.stremioTvEnabled = boolEnv(env, "HA_SOL_TV_ENABLED", false);
    this.stremioTvUrl = normalizeTvUrl(env.HA_SOL_TV_URL || "");
    this.stremioTvTimeoutMs = numberEnv(env, "HA_SOL_TV_TIMEOUT_MS", 8000, 1000, 30000);
    this.stremioAutoSelectAttempts = numberEnv(env, "HA_SOL_STREMIO_AUTOSELECT_ATTEMPTS", 6, 1, 12);
  }

  stremioStatus() {
    return {
      ...super.stremioStatus(),
      visualAutoSelect: {
        enabled: this.stremioAutoSelectStream,
        configured: this.stremioTvEnabled && Boolean(this.stremioTvUrl),
        attempts: this.stremioAutoSelectAttempts,
        transport: "Android TV Satellite click_text"
      }
    };
  }

  async tvClickText(text) {
    if (!this.stremioTvEnabled || !this.stremioTvUrl) {
      return { ok: false, reason: "tv_satellite_not_configured" };
    }

    const executeResponse = await fetch(`${this.stremioTvUrl}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actions: [{ action: "click_text", text }],
        session_id: "stremio-auto-select",
        screenshot: false,
        quiet_ms: 160,
        wait_timeout_ms: 1600,
        gap_ms: 60
      }),
      signal: AbortSignal.timeout(Math.max(this.stremioTvTimeoutMs, 5000))
    }).catch(() => null);

    if (executeResponse) {
      const payload = await responsePayload(executeResponse);
      const first = Array.isArray(payload?.actions) ? payload.actions[0] : null;
      if (executeResponse.ok && (first?.ok === true || (payload?.ok === true && first?.ok !== false))) {
        return { ok: true, via: "execute", text };
      }
      if (![404, 405].includes(executeResponse.status)) {
        return {
          ok: false,
          via: "execute",
          text,
          status: executeResponse.status,
          reason: first?.error || payload?.error || "text_not_clicked"
        };
      }
    }

    const legacyResponse = await fetch(`${this.stremioTvUrl}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "click_text", text }),
      signal: AbortSignal.timeout(this.stremioTvTimeoutMs)
    }).catch(() => null);
    if (!legacyResponse) return { ok: false, via: "legacy", text, reason: "tv_satellite_unreachable" };
    const payload = await responsePayload(legacyResponse);
    if (legacyResponse.ok && payload?.ok !== false) return { ok: true, via: "legacy", text };
    return {
      ok: false,
      via: "legacy",
      text,
      status: legacyResponse.status,
      reason: payload?.error || "text_not_clicked"
    };
  }

  async autoSelectVisualStream(selected) {
    if (!this.stremioAutoSelectStream) return { ok: false, reason: "stremio_visual_autoselect_disabled" };
    if (!this.stremioTvEnabled || !this.stremioTvUrl) return { ok: false, reason: "tv_satellite_not_configured" };

    const candidates = uniqueTextCandidates(selected);
    if (!candidates.length) return { ok: false, reason: "stremio_selected_stream_has_no_clickable_label" };

    const errors = [];
    for (let attempt = 1; attempt <= this.stremioAutoSelectAttempts; attempt += 1) {
      await sleep(attempt === 1 ? 850 : Math.min(1200, 350 + attempt * 130));
      for (const text of candidates) {
        const result = await this.tvClickText(text);
        if (result.ok) {
          return {
            ok: true,
            attempt,
            matchedText: text,
            via: result.via,
            candidatesTried: candidates.length
          };
        }
        errors.push({ attempt, text, reason: result.reason || "not_clicked" });
      }
    }

    return {
      ok: false,
      reason: "stremio_selected_stream_not_found_in_visible_ui",
      candidates,
      attempts: this.stremioAutoSelectAttempts,
      errors: errors.slice(-8)
    };
  }

  async handleStremioTool(tool, args = {}) {
    const result = await super.handleStremioTool(tool, args);
    if (tool !== "home_assistant_stremio_play_best") return result;
    if (result?.deliveryMode !== "visual_selection_required") return result;

    const autoSelection = await this.autoSelectVisualStream(result.selected);
    if (!autoSelection.ok) {
      return {
        ...result,
        autoSelection,
        visualSelectionHint: {
          ...(result.visualSelectionHint || {}),
          instruction: "Automatic selection was attempted but the ranked stream was not found as a clickable Accessibility label. Use home_assistant_tv_observe and select the stream matching addon/title/quality."
        }
      };
    }

    const { visualSelectionHint, ...rest } = result;
    return {
      ...rest,
      deliveryMode: "visual_selection_automatic",
      autoSelection,
      playbackRequested: true
    };
  }
}
