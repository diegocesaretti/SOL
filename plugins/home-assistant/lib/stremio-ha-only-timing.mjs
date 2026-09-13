function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberEnv(env, name, fallback, min, max) {
  const value = Number(env?.[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function haOnlyDelayMs(env = process.env) {
  const configured = numberEnv(env, "HA_SOL_STREMIO_FIRST_STREAM_DELAY_MS", 8000, 500, 15000);
  return Math.max(8000, configured);
}

export function installStremioHaOnlyTiming(SolPluginClient) {
  const proto = SolPluginClient?.prototype;
  if (!proto || proto.__stremioHaOnlyTimingInstalled) return SolPluginClient;
  proto.__stremioHaOnlyTimingInstalled = true;

  const originalWaitForStreamUi = proto.waitForStreamUi;
  const originalStatus = proto.stremioStatus;

  proto.waitForStreamUi = async function waitForStreamUiHaOnly() {
    if (this.stremioTvEnabled && this.stremioTvUrl) {
      return originalWaitForStreamUi.call(this);
    }

    const waitedMs = haOnlyDelayMs(this.env || process.env);
    await sleep(waitedMs);
    return {
      ready: true,
      via: "home_assistant_only_fixed_delay",
      waitedMs,
      confirmations: 0,
      note: "HA-only mode waits at least 8 seconds for Stremio's native stream list before sending one DPAD_CENTER through Home Assistant."
    };
  };

  proto.stremioStatus = function stremioStatusHaOnlyTiming() {
    const status = originalStatus.call(this);
    return {
      ...status,
      firstStreamAutoPlay: {
        ...(status.firstStreamAutoPlay || {}),
        delayMs: haOnlyDelayMs(this.env || process.env),
        readiness: "HA-only fixed delay; no Satellite observation",
        transport: "Home Assistant remote.send_command with command list [DPAD_CENTER]"
      }
    };
  };

  return SolPluginClient;
}
