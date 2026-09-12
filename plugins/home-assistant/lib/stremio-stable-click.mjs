function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberEnv(env, name, fallback, min, max) {
  const value = Number(env?.[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function collectUiText(node, out = [], depth = 0) {
  if (!node || typeof node !== "object" || depth > 9 || out.length > 500) return out;
  for (const key of ["text", "description", "class", "view_id", "resource_id"]) {
    if (node[key]) out.push(String(node[key]));
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectUiText(child, out, depth + 1);
  }
  return out;
}

function classifyObservation(observation) {
  const values = collectUiText(observation?.tree || observation?.root || null);
  const focus = observation?.focus_hint || observation?.focused || null;
  for (const key of ["text", "description", "class", "view_id", "resource_id"]) {
    if (focus?.[key]) values.push(String(focus[key]));
  }
  const text = values.join(" ").toLowerCase();
  const pkg = String(observation?.package || observation?.package_name || "").toLowerCase();
  return {
    stremio: pkg.includes("stremio") || text.includes("stremio"),
    loading: /\b(loading|cargando|please wait|espere|progressbar|progress bar|buffering|almacenando)\b/i.test(text),
    streamLike: /\b(2160p?|1080p?|720p?|576p?|480p?|4k|uhd|remux|blu[ -]?ray|web[ ._-]?dl|webrip|torrent|seed(?:er)?s?|debrid|cached|\d+(?:[.,]\d+)?\s*(?:gib|gb|mib|mb))\b/i.test(text),
    playerLike: /\b(pause|pausa|subtitles?|subt[ií]tulos|audio track|pista de audio|playback speed|velocidad de reproducci[oó]n|seek|retroceder|adelantar)\b/i.test(text),
    focusText: focus?.text || focus?.description || null,
    uiEventSequence: observation?.ui_event_sequence ?? null
  };
}

function settings(client) {
  const env = client?.env || process.env;
  return {
    centerDelayMs: numberEnv(env, "HA_SOL_STREMIO_CENTER_DELAY_MS", 900, 0, 5000),
    readyTimeoutMs: numberEnv(env, "HA_SOL_STREMIO_STREAM_READY_TIMEOUT_MS", 12000, 250, 30000),
    confirmations: 2
  };
}

export function installStremioStableClick(SolPluginClient) {
  const proto = SolPluginClient?.prototype;
  if (!proto || proto.__stremioStableClickInstalled) return SolPluginClient;
  proto.__stremioStableClickInstalled = true;

  const originalStatus = proto.stremioStatus;

  proto.stremioStatus = function stremioStatusWithStableClick() {
    const status = originalStatus.call(this);
    const cfg = settings(this);
    return {
      ...status,
      firstStreamAutoPlay: {
        ...(status.firstStreamAutoPlay || {}),
        readiness: this.stremioTvEnabled && this.stremioTvUrl
          ? "Android TV Satellite requires a stable stream list across two observations before sending OK"
          : "fixed fallback delay",
        centerDelayMs: cfg.centerDelayMs,
        readyTimeoutMs: cfg.readyTimeoutMs,
        stableConfirmations: cfg.confirmations,
        blindTimeoutClick: false
      }
    };
  };

  proto.waitForStreamUi = async function waitForStableStreamUi() {
    if (!this.stremioTvEnabled || !this.stremioTvUrl) {
      await sleep(this.stremioFirstStreamDelayMs);
      return {
        ready: true,
        via: "fixed_delay",
        waitedMs: this.stremioFirstStreamDelayMs,
        confirmations: 0,
        note: "TV Satellite is unavailable, so the legacy configurable fixed delay is used."
      };
    }

    const cfg = settings(this);
    const started = Date.now();
    let last = null;
    let firstReadyAt = null;
    let confirmations = 0;
    await sleep(350);

    while (Date.now() - started < cfg.readyTimeoutMs) {
      const observation = await this.tvObserveRaw(650);
      if (observation) {
        last = classifyObservation(observation);

        if (last.playerLike) {
          return {
            ready: false,
            alreadyPlaying: true,
            via: "tv_satellite_player_visible",
            waitedMs: Date.now() - started,
            confirmations,
            state: last
          };
        }

        const streamReady = last.stremio && !last.loading && last.streamLike;
        if (streamReady) {
          confirmations += 1;
          if (firstReadyAt === null) firstReadyAt = Date.now();
          const stableForMs = Date.now() - firstReadyAt;
          if (confirmations >= cfg.confirmations && stableForMs >= cfg.centerDelayMs) {
            return {
              ready: true,
              via: "tv_satellite_stable_stream_list",
              waitedMs: Date.now() - started,
              stableForMs,
              centerDelayMs: cfg.centerDelayMs,
              confirmations,
              state: last,
              note: "The native Stremio stream list remained visible long enough to safely send DPAD_CENTER."
            };
          }
        } else {
          firstReadyAt = null;
          confirmations = 0;
        }
      } else {
        firstReadyAt = null;
        confirmations = 0;
      }

      await sleep(200);
    }

    return {
      ready: false,
      via: "tv_satellite_timeout_no_click",
      waitedMs: Date.now() - started,
      confirmations,
      centerDelayMs: cfg.centerDelayMs,
      state: last,
      reason: "stremio_stream_list_not_stably_visible",
      note: "The stream list was not confirmed as stable before the timeout, so DPAD_CENTER was deliberately not sent."
    };
  };

  proto.clickFirstStream = async function clickFirstStableStream() {
    if (!this.stremioAutoPlayFirstStream) return { ok: false, reason: "stremio_first_stream_autoplay_disabled" };
    if (!this.stremioRemoteEntityId) return { ok: false, reason: "stremio_remote_entity_id_required" };

    const readiness = await this.waitForStreamUi();
    if (readiness.alreadyPlaying) {
      return {
        ok: true,
        skipped: true,
        reason: "stremio_player_already_visible",
        readiness,
        playbackVerification: {
          status: "confirmed",
          confirmed: true,
          via: "tv_satellite_accessibility",
          screenshotRequired: false,
          waitedMs: readiness.waitedMs,
          state: readiness.state
        }
      };
    }

    if (readiness.ready !== true) {
      return {
        ok: false,
        commandSent: false,
        reason: readiness.reason || "stremio_stream_ui_not_ready",
        readiness
      };
    }

    try {
      const result = await this.haService("remote", "send_command", {
        entity_id: this.stremioRemoteEntityId,
        command: "DPAD_CENTER"
      });
      const playbackVerification = await this.verifyPlayback();
      return {
        ok: true,
        commandSent: true,
        via: "home_assistant_remote",
        service: "remote.send_command",
        remoteEntityId: this.stremioRemoteEntityId,
        command: "DPAD_CENTER",
        readiness,
        playbackVerification,
        result
      };
    } catch (error) {
      return {
        ok: false,
        commandSent: false,
        reason: error?.message || String(error),
        readiness
      };
    }
  };

  return SolPluginClient;
}
