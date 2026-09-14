function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clean(value) {
  return String(value ?? "").trim();
}

async function remoteCommand(client, command, delayMs = 0) {
  if (!client?.stremioRemoteEntityId) {
    return { ok: false, skipped: true, command, reason: "stremio_remote_entity_id_required" };
  }
  try {
    const result = await client.haService("remote", "send_command", {
      entity_id: client.stremioRemoteEntityId,
      command: [command]
    });
    if (delayMs > 0) await sleep(delayMs);
    return { ok: true, command, delayMs, via: "home_assistant_remote", result };
  } catch (error) {
    return { ok: false, command, delayMs, reason: error?.message || String(error) };
  }
}

export async function wakeForStremio(client, { command = "0", delayMs = 450 } = {}) {
  return remoteCommand(client, command, delayMs);
}

export async function recoverForegroundApp(client, { delayMs = 700 } = {}) {
  return remoteCommand(client, "HOME", delayMs);
}

function isDetailDeepLink(uri) {
  const value = clean(uri).toLowerCase();
  return value.startsWith("stremio://") && value.includes("/detail/");
}

export function installStremioLaunchGuard(SolPluginClient, {
  wakeCommand = "0",
  wakeDelayMs = 450
} = {}) {
  const proto = SolPluginClient?.prototype;
  if (!proto || proto.__stremioLaunchGuardInstalled) return SolPluginClient;
  proto.__stremioLaunchGuardInstalled = true;

  const originalHandle = proto.handleStremioTool;
  const originalLaunch = proto.launchStremio;
  const originalStatus = proto.stremioStatus;

  proto.stremioStatus = function stremioStatusWithLaunchGuard() {
    return {
      ...originalStatus.call(this),
      launchGuard: {
        enabled: true,
        mode: "home_assistant_wake_before_detail",
        wakeCommand,
        wakeDelayMs,
        visualWatchdog: false,
        note: "Before a Stremio detail launch, SOL sends one wake key through Home Assistant and then opens the deep link."
      }
    };
  };

  proto.handleStremioTool = async function handleStremioToolWithLaunchGuard(tool, args = {}) {
    const playbackTool = tool === "home_assistant_stremio_play_best" || tool === "home_assistant_stremio_play";
    if (!playbackTool) return originalHandle.call(this, tool, args);
    const previous = this.__stremioLaunchGuardContext;
    const context = { active: true, last: null };
    this.__stremioLaunchGuardContext = context;
    try {
      const result = await originalHandle.call(this, tool, args);
      return context.last && result && typeof result === "object"
        ? { ...result, launchGuard: context.last }
        : result;
    } finally {
      this.__stremioLaunchGuardContext = previous;
    }
  };

  proto.launchStremio = async function launchStremioWithGuard(uri) {
    const context = this.__stremioLaunchGuardContext;
    if (!context?.active || !isDetailDeepLink(uri)) return originalLaunch.call(this, uri);

    const wake = await wakeForStremio(this, { command: wakeCommand, delayMs: wakeDelayMs });
    const launch = await originalLaunch.call(this, uri);
    const guard = {
      ok: true,
      mode: "home_assistant_only",
      wake: {
        ok: wake.ok === true,
        skipped: Boolean(wake.skipped),
        command: wake.command || wakeCommand,
        reason: wake.reason || null
      },
      allowStreamInput: true,
      visualWatchdog: false
    };
    context.last = guard;
    return { ...launch, launchGuard: guard };
  };

  return SolPluginClient;
}

export const __test = { isDetailDeepLink };
