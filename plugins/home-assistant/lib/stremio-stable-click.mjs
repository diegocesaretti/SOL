function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberEnv(env, name, fallback, min, max) {
  const value = Number(env?.[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function centerTransport(env) {
  const value = String(env?.HA_SOL_STREMIO_CENTER_TRANSPORT || "auto").trim().toLowerCase();
  return ["auto", "satellite", "home_assistant"].includes(value) ? value : "auto";
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
    centerTransport: centerTransport(env),
    confirmations: 2
  };
}

async function responsePayload(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return await response.json().catch(() => ({}));
  return { error: (await response.text().catch(() => "")).slice(0, 500) || `HTTP ${response.status}` };
}

async function sendCenterViaSatellite(client) {
  if (!client?.stremioTvEnabled || !client?.stremioTvUrl) {
    return { ok: false, via: "tv_satellite", reason: "tv_satellite_not_configured", fallback: "home_assistant" };
  }

  const executeResponse = await fetch(`${client.stremioTvUrl}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actions: [{ action: "dpad_center" }],
      session_id: "stremio-center",
      screenshot: false,
      quiet_ms: 180,
      wait_timeout_ms: 1800,
      gap_ms: 60
    }),
    signal: AbortSignal.timeout(Math.max(client.stremioTvTimeoutMs || 8000, 5500))
  }).catch((error) => ({ transportError: error?.message || String(error) }));

  if (executeResponse?.transportError) {
    return { ok: false, via: "tv_satellite_execute", reason: executeResponse.transportError, fallback: "home_assistant" };
  }

  const executePayload = await responsePayload(executeResponse);
  const first = Array.isArray(executePayload?.actions) ? executePayload.actions[0] : null;
  if (executeResponse.ok && (first?.ok === true || (executePayload?.ok === true && first?.ok !== false))) {
    return {
      ok: true,
      via: "tv_satellite_execute",
      action: "dpad_center",
      httpStatus: executeResponse.status,
      actionResult: first ? { ok: first.ok, fallback: first.fallback || null } : { ok: true }
    };
  }

  if (![404, 405].includes(executeResponse.status)) {
    return {
      ok: false,
      via: "tv_satellite_execute",
      action: "dpad_center",
      httpStatus: executeResponse.status,
      reason: first?.error || executePayload?.error || "tv_satellite_center_not_injected",
      fallback: first?.fallback || "home_assistant"
    };
  }

  const legacyResponse = await fetch(`${client.stremioTvUrl}/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "dpad_center" }),
    signal: AbortSignal.timeout(client.stremioTvTimeoutMs || 8000)
  }).catch((error) => ({ transportError: error?.message || String(error) }));

  if (legacyResponse?.transportError) {
    return { ok: false, via: "tv_satellite_legacy", reason: legacyResponse.transportError, fallback: "home_assistant" };
  }

  const legacyPayload = await responsePayload(legacyResponse);
  if (legacyResponse.ok && legacyPayload?.ok !== false) {
    return {
      ok: true,
      via: "tv_satellite_legacy",
      action: "dpad_center",
      httpStatus: legacyResponse.status
    };
  }

  return {
    ok: false,
    via: "tv_satellite_legacy",
    action: "dpad_center",
    httpStatus: legacyResponse.status,
    reason: legacyPayload?.error || "tv_satellite_center_not_injected",
    fallback: legacyPayload?.fallback || "home_assistant"
  };
}

async function sendCenterViaHomeAssistant(client, satelliteResult = null) {
  if (!client?.stremioRemoteEntityId) {
    return { ok: false, via: "home_assistant_remote", reason: "stremio_remote_entity_id_required", satelliteResult };
  }
  try {
    const result = await client.haService("remote", "send_command", {
      entity_id: client.stremioRemoteEntityId,
      command: ["DPAD_CENTER"]
    });
    return {
      ok: true,
      via: satelliteResult ? "home_assistant_remote_fallback" : "home_assistant_remote",
      service: "remote.send_command",
      remoteEntityId: client.stremioRemoteEntityId,
      command: "DPAD_CENTER",
      commandPayload: ["DPAD_CENTER"],
      satelliteResult,
      result
    };
  } catch (error) {
    return {
      ok: false,
      via: satelliteResult ? "home_assistant_remote_fallback" : "home_assistant_remote",
      command: "DPAD_CENTER",
      reason: error?.message || String(error),
      satelliteResult
    };
  }
}

async function sendCenter(client, transport) {
  if (transport === "home_assistant") return sendCenterViaHomeAssistant(client);

  const satelliteResult = await sendCenterViaSatellite(client);
  if (satelliteResult.ok || transport === "satellite") return satelliteResult;

  return sendCenterViaHomeAssistant(client, satelliteResult);
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
        centerTransport: cfg.centerTransport,
        centerTransportPolicy: "auto uses TV Satellite dpad_center first and falls back to Home Assistant only when Satellite reports failure",
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

    const cfg = settings(this);
    const center = await sendCenter(this, cfg.centerTransport);
    this.__stremioDebugEvent?.("center_transport", {
      requested: cfg.centerTransport,
      ok: center?.ok === true,
      via: center?.via || null,
      reason: center?.reason || null,
      fallback: center?.fallback || center?.satelliteResult?.fallback || null,
      satelliteVia: center?.satelliteResult?.via || null
    });

    if (!center.ok) {
      return {
        ok: false,
        commandSent: false,
        reason: center.reason || "stremio_center_command_failed",
        readiness,
        centerTransport: cfg.centerTransport,
        center
      };
    }

    const playbackVerification = await this.verifyPlayback();
    return {
      ok: true,
      commandSent: true,
      via: center.via,
      service: center.service || null,
      remoteEntityId: center.remoteEntityId || null,
      command: "DPAD_CENTER",
      readiness,
      centerTransport: cfg.centerTransport,
      center,
      playbackVerification
    };
  };

  return SolPluginClient;
}
