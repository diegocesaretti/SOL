function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clean(value) {
  return String(value ?? "").trim();
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

function normalizedText(value) {
  return clean(value).toLowerCase().replace(/\s+/g, " ");
}

function launcherPackage(packageName) {
  const pkg = normalizedText(packageName);
  if (!pkg) return false;
  return pkg === "com.google.android.tvlauncher"
    || pkg === "com.google.android.apps.tv.launcherx"
    || pkg === "com.android.tv.launcher"
    || pkg === "com.google.android.leanbacklauncher"
    || /(?:^|\.)(?:tv)?launcherx?(?:\.|$)/.test(pkg);
}

function systemPackage(packageName) {
  const pkg = normalizedText(packageName);
  return !pkg || pkg.includes("systemui") || pkg.includes("permissioncontroller") || pkg.includes("packageinstaller");
}

export function classifyLaunchObservation(observation, expectedTitle = "") {
  const values = collectUiText(observation?.tree || observation?.root || null);
  const focus = observation?.focus_hint || observation?.focused || null;
  for (const key of ["text", "description", "class", "view_id", "resource_id"]) {
    if (focus?.[key]) values.push(String(focus[key]));
  }
  const text = normalizedText(values.join(" "));
  const packageName = normalizedText(observation?.package || observation?.package_name || "");
  const expected = normalizedText(expectedTitle);
  const stremio = packageName.includes("stremio") || text.includes("stremio");
  const homeScreen = !stremio && launcherPackage(packageName);
  const wrongApp = !stremio && !homeScreen && !systemPackage(packageName);
  const loading = /\b(loading|cargando|please wait|espere|progressbar|progress bar|buffering|almacenando)\b/i.test(text);
  const streamLike = /\b(2160p?|1080p?|720p?|576p?|480p?|4k|uhd|remux|blu[ -]?ray|web[ ._-]?dl|webrip|torrent|seed(?:er)?s?|debrid|cached|\d+(?:[.,]\d+)?\s*(?:gib|gb|mib|mb))\b/i.test(text);
  const playerLike = /\b(pause|pausa|subtitles?|subt[ií]tulos|audio track|pista de audio|playback speed|velocidad de reproducci[oó]n|seek|retroceder|adelantar)\b/i.test(text);
  const expectedVisible = expected.length >= 4 && text.includes(expected);
  return {
    packageName: packageName || null,
    stremio,
    homeScreen,
    wrongApp,
    loading,
    streamLike,
    playerLike,
    expectedVisible,
    focusText: focus?.text || focus?.description || null,
    uiEventSequence: observation?.ui_event_sequence ?? null
  };
}

function sampledHash(bytes) {
  if (!bytes?.length) return null;
  let hash = 2166136261;
  const step = Math.max(1, Math.floor(bytes.length / 4096));
  for (let i = 0; i < bytes.length; i += step) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export async function screenshotProbe(client) {
  if (!client?.stremioTvEnabled || !client?.stremioTvUrl) {
    return { available: false, ok: false, reason: "tv_satellite_not_configured" };
  }
  try {
    const url = new URL(`${client.stremioTvUrl}/screenshot`);
    url.searchParams.set("profile", "preview");
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(client.stremioTvTimeoutMs || 8000)
    });
    if (!response.ok) {
      return { available: true, ok: false, status: response.status, reason: `tv_screenshot_http_${response.status}` };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const dHash = clean(response.headers.get("x-codex-dhash")) || null;
    return {
      available: true,
      ok: true,
      profile: response.headers.get("x-codex-profile") || "preview",
      bytes: bytes.length,
      dHash,
      signature: dHash || sampledHash(bytes)
    };
  } catch (error) {
    return { available: true, ok: false, reason: error?.message || String(error) };
  }
}

function frameChanged(before, after) {
  if (!before?.ok || !after?.ok || !before.signature || !after.signature) return null;
  return before.signature !== after.signature;
}

export async function wakeForStremio(client, { command = "0", delayMs = 450 } = {}) {
  if (!client?.stremioRemoteEntityId) {
    return { ok: false, skipped: true, reason: "stremio_remote_entity_id_required" };
  }
  try {
    const result = await client.haService("remote", "send_command", {
      entity_id: client.stremioRemoteEntityId,
      command
    });
    await sleep(delayMs);
    return {
      ok: true,
      command,
      delayMs,
      via: "home_assistant_remote",
      result
    };
  } catch (error) {
    return { ok: false, command, delayMs, reason: error?.message || String(error) };
  }
}

export async function inspectStremioLaunch(client, {
  beforeFrame = null,
  expectedTitle = "",
  timeoutMs = 4500
} = {}) {
  if (!client?.stremioTvEnabled || !client?.stremioTvUrl) {
    return {
      status: "unverified",
      allowStreamInput: true,
      reason: "tv_satellite_not_configured",
      screenshotChecked: false
    };
  }

  const started = Date.now();
  let last = null;
  let homeHits = 0;
  let wrongAppHits = 0;
  let sawVisualChange = false;
  await sleep(650);

  while (Date.now() - started < timeoutMs) {
    const [observation, frame] = await Promise.all([
      client.tvObserveRaw(450),
      screenshotProbe(client)
    ]);
    const state = observation ? classifyLaunchObservation(observation, expectedTitle) : null;
    const changed = frameChanged(beforeFrame, frame);
    if (changed === true) sawVisualChange = true;

    if (state?.homeScreen) homeHits += 1;
    else homeHits = 0;
    if (state?.wrongApp) wrongAppHits += 1;
    else wrongAppHits = 0;

    last = {
      state,
      frame: frame?.ok ? { profile: frame.profile, bytes: frame.bytes, dHash: frame.dHash, signature: frame.signature } : frame,
      frameChanged: changed,
      waitedMs: Date.now() - started
    };

    if (state?.stremio && state.playerLike) {
      return { status: "player_visible", allowStreamInput: true, screenshotChecked: true, ...last };
    }
    if (state?.stremio && state.streamLike) {
      return { status: "stream_list_visible", allowStreamInput: true, screenshotChecked: true, ...last };
    }
    if (state?.stremio && state.expectedVisible) {
      return { status: "requested_title_visible", allowStreamInput: true, screenshotChecked: true, ...last };
    }
    if (state?.stremio && state.loading) {
      return { status: "stremio_loading", allowStreamInput: true, screenshotChecked: true, ...last };
    }
    if (homeHits >= 2) {
      return { status: "home_screen", allowStreamInput: false, screenshotChecked: true, ...last };
    }
    if (wrongAppHits >= 2) {
      return { status: "wrong_app", allowStreamInput: false, screenshotChecked: true, ...last };
    }
    await sleep(250);
  }

  if (last?.state?.stremio) {
    return {
      status: "stremio_visible",
      allowStreamInput: true,
      screenshotChecked: true,
      visualTransition: sawVisualChange,
      ...last
    };
  }
  if (sawVisualChange) {
    return {
      status: "visual_transition_unverified",
      allowStreamInput: true,
      screenshotChecked: true,
      visualTransition: true,
      ...last,
      note: "The screenshot changed after the deep link, but Accessibility did not expose enough UI text to classify the Stremio screen."
    };
  }
  return {
    status: "stalled",
    allowStreamInput: false,
    screenshotChecked: true,
    visualTransition: false,
    ...last,
    note: "The deep link produced no confirmed Stremio state and no screenshot transition."
  };
}

function isDetailDeepLink(uri) {
  const value = clean(uri).toLowerCase();
  return value.startsWith("stremio://") && value.includes("/detail/");
}

export function installStremioLaunchGuard(SolPluginClient, {
  wakeCommand = "0",
  wakeDelayMs = 450,
  watchdogMs = 4500,
  retryCount = 1
} = {}) {
  const proto = SolPluginClient?.prototype;
  if (!proto || proto.__stremioLaunchGuardInstalled) return SolPluginClient;
  proto.__stremioLaunchGuardInstalled = true;

  const originalHandle = proto.handleStremioTool;
  const originalLaunch = proto.launchStremio;
  const originalClickFirst = proto.clickFirstStream;
  const originalVisualSelect = proto.autoSelectVisualStream;
  const originalStatus = proto.stremioStatus;

  proto.stremioStatus = function stremioStatusWithLaunchGuard() {
    return {
      ...originalStatus.call(this),
      launchGuard: {
        enabled: true,
        wakeCommand,
        wakeDelayMs,
        watchdogMs,
        retryCount,
        screenshotCheck: true,
        homeScreenRecovery: true,
        note: "Before play_best, SOL sends Android TV key 0, then verifies the Stremio launch with Satellite screenshots plus Accessibility and relaunches the deep link when the launcher/home screen remains visible."
      }
    };
  };

  proto.handleStremioTool = async function handleStremioToolWithLaunchGuard(tool, args = {}) {
    if (tool !== "home_assistant_stremio_play_best") return originalHandle.call(this, tool, args);
    const previous = this.__stremioLaunchGuardContext;
    const context = {
      active: true,
      expectedTitle: clean(args.query || ""),
      last: null
    };
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

    const attempts = [];
    let launch = null;
    let inspection = null;
    let retries = 0;

    while (retries <= retryCount) {
      const wake = await wakeForStremio(this, { command: wakeCommand, delayMs: wakeDelayMs });
      const beforeFrame = await screenshotProbe(this);
      launch = await originalLaunch.call(this, uri);
      inspection = await inspectStremioLaunch(this, {
        beforeFrame,
        expectedTitle: context.expectedTitle,
        timeoutMs: watchdogMs
      });
      attempts.push({
        attempt: retries + 1,
        wake: { ok: wake.ok, skipped: Boolean(wake.skipped), command: wake.command || wakeCommand, reason: wake.reason || null },
        beforeFrame: beforeFrame?.ok ? { profile: beforeFrame.profile, bytes: beforeFrame.bytes, dHash: beforeFrame.dHash, signature: beforeFrame.signature } : beforeFrame,
        inspection
      });

      if (inspection.allowStreamInput) break;
      if (!['home_screen', 'wrong_app', 'stalled'].includes(inspection.status)) break;
      if (retries >= retryCount) break;
      retries += 1;
    }

    const guard = {
      ok: Boolean(inspection?.allowStreamInput),
      wakeCommand,
      retries,
      finalStatus: inspection?.status || "unverified",
      allowStreamInput: inspection?.allowStreamInput !== false,
      screenshotChecked: Boolean(inspection?.screenshotChecked),
      attempts
    };
    context.last = guard;
    return { ...launch, launchGuard: guard };
  };

  proto.clickFirstStream = async function clickFirstStreamWithGuard(...args) {
    const guard = this.__stremioLaunchGuardContext?.last;
    if (guard && guard.allowStreamInput === false) {
      return {
        ok: false,
        reason: "stremio_launch_guard_blocked_stream_input",
        launchGuard: guard
      };
    }
    return originalClickFirst.apply(this, args);
  };

  proto.autoSelectVisualStream = async function autoSelectVisualStreamWithGuard(...args) {
    const guard = this.__stremioLaunchGuardContext?.last;
    if (guard && guard.allowStreamInput === false) {
      return {
        ok: false,
        reason: "stremio_launch_guard_blocked_visual_selection",
        launchGuard: guard
      };
    }
    return originalVisualSelect.apply(this, args);
  };

  return SolPluginClient;
}
