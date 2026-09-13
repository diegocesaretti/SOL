function clean(value) {
  return String(value ?? "").trim();
}

function numberEnv(env, name, fallback, min, max) {
  const value = Number(env?.[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPlaybackTool(tool) {
  return tool === "home_assistant_stremio_play_best" || tool === "home_assistant_stremio_play";
}

function requestsIndexedLanguage(args = {}) {
  const language = clean(args?.language).toLowerCase();
  if (language === "latin" || language === "spanish") return true;
  const profile = clean(args?.profile || "auto").toLowerCase();
  return profile === "family" || profile === "kids";
}

export function configuredOpenToKeysDelayMs(env = process.env) {
  return numberEnv(env, "HA_SOL_STREMIO_OPEN_TO_KEYS_DELAY_MS", 1500, 0, 15000);
}

export function installStremioOpenToKeysDelay(SolPluginClient) {
  const proto = SolPluginClient?.prototype;
  if (!proto || proto.__stremioOpenToKeysDelayInstalled) return SolPluginClient;
  proto.__stremioOpenToKeysDelayInstalled = true;

  const originalHandle = proto.handleStremioTool;
  const originalWait = proto.waitForStreamUi;
  const originalStatus = proto.stremioStatus;

  proto.stremioStatus = function stremioStatusWithOpenToKeysDelay() {
    const status = originalStatus.call(this);
    return {
      ...status,
      openToKeysDelay: {
        delayMs: configuredOpenToKeysDelayMs(this.env || process.env),
        scope: "indexed_spanish_latin_navigation",
        startsAfter: "stremio_detail_open_ok",
        endsBefore: "first_dpad_right_or_center"
      }
    };
  };

  proto.waitForStreamUi = async function waitForStreamUiWithOpenToKeysDelay(...args) {
    const indexedContext = Boolean(this.__stremioIndexedSelectionContext?.active);
    const active = Boolean(this.__stremioOpenToKeysDelayActive || indexedContext);
    if (!active) return originalWait.apply(this, args);

    const delayMs = configuredOpenToKeysDelayMs(this.env || process.env);

    // Current SOL policy is HA-only TV control, so there is intentionally no
    // Accessibility/Satellite readiness probe here. The configurable delay is
    // the stabilization window between launchStremio() returning and the first
    // indexed DPAD command.
    if (!this.stremioTvEnabled || !this.stremioTvUrl) {
      if (delayMs > 0) await sleep(delayMs);
      return {
        ready: true,
        via: "configurable_open_to_keys_delay",
        waitedMs: delayMs,
        openToKeysDelayMs: delayMs
      };
    }

    return originalWait.apply(this, args);
  };

  proto.handleStremioTool = async function handleStremioToolWithOpenToKeysDelay(tool, args = {}) {
    const previous = this.__stremioOpenToKeysDelayActive;
    const activate = isPlaybackTool(tool) && requestsIndexedLanguage(args);
    if (activate) this.__stremioOpenToKeysDelayActive = true;
    try {
      return await originalHandle.call(this, tool, args);
    } finally {
      this.__stremioOpenToKeysDelayActive = previous;
    }
  };

  return SolPluginClient;
}

export const __test = {
  isPlaybackTool,
  requestsIndexedLanguage
};
