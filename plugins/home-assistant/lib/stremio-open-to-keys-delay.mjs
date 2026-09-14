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

function remoteCommand(payload) {
  const value = payload?.command;
  if (Array.isArray(value) && value.length === 1) return clean(value[0]).toUpperCase();
  if (typeof value === "string") return clean(value).toUpperCase();
  return "";
}

export function configuredOpenToKeysDelayMs(env = process.env) {
  return numberEnv(env, "HA_SOL_STREMIO_OPEN_TO_KEYS_DELAY_MS", 1500, 0, 60000);
}

export function configuredIndexedInitialFocusIndex(env = process.env) {
  return numberEnv(env, "HA_SOL_STREMIO_INDEXED_INITIAL_FOCUS_INDEX", 1, 0, 5);
}

export function configuredIndexedCenterDelayMs(env = process.env) {
  const keyDelayFallback = numberEnv(env, "HA_SOL_STREMIO_INDEXED_KEY_DELAY_MS", 250, 0, 1000);
  return numberEnv(env, "HA_SOL_STREMIO_INDEXED_CENTER_DELAY_MS", keyDelayFallback, 0, 5000);
}

export function installStremioOpenToKeysDelay(SolPluginClient) {
  const proto = SolPluginClient?.prototype;
  if (!proto || proto.__stremioOpenToKeysDelayInstalled) return SolPluginClient;
  proto.__stremioOpenToKeysDelayInstalled = true;

  const originalHandle = proto.handleStremioTool;
  const originalWait = proto.waitForStreamUi;
  const originalStatus = proto.stremioStatus;

  proto.stremioStatus = function stremioStatusWithOpenToKeysDelay() {
    const env = this.env || process.env;
    const status = originalStatus.call(this);
    return {
      ...status,
      openToKeysDelay: {
        delayMs: configuredOpenToKeysDelayMs(env),
        scope: "indexed_spanish_latin_navigation",
        startsAfter: "stremio_detail_open_ok",
        endsBefore: "first_dpad_right_or_center",
        maxMs: 60000
      },
      indexedNavigationTiming: {
        initialFocusIndex: configuredIndexedInitialFocusIndex(env),
        centerDelayMs: configuredIndexedCenterDelayMs(env),
        policy: "Treat Stremio native stream focus as configurable; compensate the initial focus before CENTER."
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
    const previousActive = this.__stremioOpenToKeysDelayActive;
    const activate = isPlaybackTool(tool) && requestsIndexedLanguage(args);
    if (activate) this.__stremioOpenToKeysDelayActive = true;

    const env = this.env || process.env;
    const initialFocusIndex = configuredIndexedInitialFocusIndex(env);
    const centerDelayMs = configuredIndexedCenterDelayMs(env);
    const keyDelayMs = numberEnv(env, "HA_SOL_STREMIO_INDEXED_KEY_DELAY_MS", 250, 0, 1000);
    const navigation = {
      active: activate,
      initialFocusIndex,
      requestedRights: 0,
      suppressedRights: 0,
      forwardedRights: 0,
      injectedLefts: 0,
      centerDelayMs,
      centerSent: false
    };

    const hadOwnHaService = Object.prototype.hasOwnProperty.call(this, "haService");
    const previousHaService = this.haService;

    if (activate && typeof previousHaService === "function") {
      this.haService = async (domain, service, payload = {}) => {
        const command = domain === "remote" && service === "send_command"
          ? remoteCommand(payload)
          : "";

        if (command === "DPAD_RIGHT") {
          navigation.requestedRights += 1;
          if (navigation.suppressedRights < initialFocusIndex) {
            navigation.suppressedRights += 1;
            return {
              ok: true,
              suppressed: true,
              reason: "stremio_index_initial_focus_compensation"
            };
          }
          navigation.forwardedRights += 1;
          return previousHaService.call(this, domain, service, payload);
        }

        if (command === "DPAD_CENTER") {
          const missingLefts = Math.max(0, initialFocusIndex - navigation.requestedRights);
          for (let index = 0; index < missingLefts; index += 1) {
            await previousHaService.call(this, "remote", "send_command", {
              ...payload,
              command: ["DPAD_LEFT"]
            });
            navigation.injectedLefts += 1;
            if (keyDelayMs > 0 && index < missingLefts - 1) await sleep(keyDelayMs);
          }

          if (centerDelayMs > 0) await sleep(centerDelayMs);
          const result = await previousHaService.call(this, domain, service, payload);
          navigation.centerSent = true;
          return result;
        }

        return previousHaService.call(this, domain, service, payload);
      };
    }

    let result;
    try {
      result = await originalHandle.call(this, tool, args);
    } finally {
      this.__stremioOpenToKeysDelayActive = previousActive;
      if (activate && typeof previousHaService === "function") {
        if (hadOwnHaService) this.haService = previousHaService;
        else delete this.haService;
      }
    }

    if (activate && result && typeof result === "object") {
      return {
        ...result,
        indexedNavigationAdjustment: navigation
      };
    }
    return result;
  };

  return SolPluginClient;
}

export const __test = {
  isPlaybackTool,
  remoteCommand,
  requestsIndexedLanguage
};
