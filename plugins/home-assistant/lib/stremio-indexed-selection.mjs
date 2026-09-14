import {
  StremioAddonAggregator,
  inspectStream,
  summarizeRankedStream
} from "./stremio-addons.mjs";
import { installStremioAddonCompatibilityPatch } from "./stremio-addon-compat.mjs";
import { detailDeepLink } from "./stremio.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function boolEnv(env, name, fallback = false) {
  const value = env?.[name];
  if (value === undefined || value === null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function numberEnv(env, name, fallback, min, max) {
  const value = Number(env?.[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


export function indexedNavigationTiming(env = process.env) {
  const keyDelayMs = numberEnv(env, "HA_SOL_STREMIO_INDEXED_KEY_DELAY_MS", 250, 0, 1000);
  return {
    openToKeysDelayMs: numberEnv(env, "HA_SOL_STREMIO_OPEN_TO_KEYS_DELAY_MS", 1500, 0, 60000),
    keyDelayMs,
    initialFocusIndex: numberEnv(env, "HA_SOL_STREMIO_INDEXED_INITIAL_FOCUS_INDEX", 1, 0, 5),
    centerDelayMs: numberEnv(env, "HA_SOL_STREMIO_INDEXED_CENTER_DELAY_MS", keyDelayMs, 0, 5000)
  };
}

async function waitForIndexedNavigation(env = process.env) {
  const timing = indexedNavigationTiming(env);
  if (timing.openToKeysDelayMs > 0) await sleep(timing.openToKeysDelayMs);
  return {
    ready: true,
    via: "configurable_open_to_keys_delay",
    waitedMs: timing.openToKeysDelayMs,
    openToKeysDelayMs: timing.openToKeysDelayMs
  };
}

function selectedLanguages(selected) {
  return Array.isArray(selected?.languages)
    ? selected.languages.map((value) => clean(value).toLowerCase()).filter(Boolean)
    : [];
}

function requestedLanguage(args = {}) {
  const explicit = clean(args?.language || "").toLowerCase();
  if (explicit === "latin" || explicit === "spanish") return explicit;
  const profile = clean(args?.profile || "auto").toLowerCase();
  if (profile === "family" || profile === "kids") return "latin";
  return "";
}

export function requiresExactLanguageSelection(selected, args = {}) {
  if (requestedLanguage(args)) return true;
  const languages = selectedLanguages(selected);
  return languages.includes("latin") || languages.includes("spanish");
}

function languageMatches(details, language) {
  const languages = Array.isArray(details?.languages) ? details.languages : [];
  if (language === "latin") return languages.includes("latin");
  if (language === "spanish") return languages.includes("spanish") || languages.includes("latin");
  return true;
}

function requestedResolution(value) {
  const text = clean(value).toLowerCase();
  if (!text || text === "auto" || text === "any") return null;
  if (["4k", "2160", "2160p"].includes(text)) return 2160;
  const parsed = Number(text.replace(/p$/, ""));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function preferSubset(candidates, predicate) {
  const subset = candidates.filter(predicate);
  return subset.length ? subset : candidates;
}

export function chooseNativeLanguageStream(slices, args = {}) {
  const language = requestedLanguage(args);
  if (!language) return { ok: false, reason: "stremio_native_language_not_requested" };

  const candidates = [];
  let nativeIndex = 0;
  for (const slice of Array.isArray(slices) ? slices : []) {
    const streams = Array.isArray(slice?.streams) ? slice.streams : [];
    for (const entry of streams) {
      const details = entry?.details || inspectStream(entry?.stream || {});
      if (languageMatches(details, language)) {
        candidates.push({
          entry,
          details,
          nativeIndex,
          addonId: clean(slice?.addonId || entry?.addon?.id),
          addonName: clean(slice?.addonName || entry?.addon?.name) || null,
          providerIndex: Number(entry?.providerIndex)
        });
      }
      nativeIndex += 1;
    }
  }

  if (!candidates.length) {
    return {
      ok: false,
      reason: language === "latin" ? "stremio_account_no_latin_streams" : "stremio_account_no_spanish_streams",
      language,
      scannedStreamCount: nativeIndex
    };
  }

  let preferred = candidates;
  const maxSizeGb = Number(args?.maxSizeGb || 0);
  if (Number.isFinite(maxSizeGb) && maxSizeGb > 0) {
    preferred = preferSubset(preferred, (candidate) => candidate.details.sizeGb === null || candidate.details.sizeGb <= maxSizeGb);
  }

  const resolution = requestedResolution(args?.quality);
  if (resolution) preferred = preferSubset(preferred, (candidate) => candidate.details.quality === resolution);

  const codec = clean(args?.codec || "any").toLowerCase();
  if (codec && codec !== "any") preferred = preferSubset(preferred, (candidate) => candidate.details.codec === codec);

  if (args?.preferDolbyVision === true) preferred = preferSubset(preferred, (candidate) => candidate.details.dolbyVision === true);
  if (args?.preferHdr === true) preferred = preferSubset(preferred, (candidate) => candidate.details.hdr === true);
  preferred = preferSubset(preferred, (candidate) => candidate.details.badSource !== true);

  const chosen = preferred[0];
  const selected = {
    ...summarizeRankedStream({ ...chosen.entry, details: chosen.details }),
    addonId: chosen.addonId,
    addonName: chosen.addonName,
    providerIndex: chosen.providerIndex,
    nativeIndex: chosen.nativeIndex
  };

  return {
    ok: true,
    language,
    selected,
    nativeIndex: chosen.nativeIndex,
    matchingCount: candidates.length,
    scannedStreamCount: nativeIndex
  };
}

export function planFromProviderSlices(slices, selected, { maxIndex = 100 } = {}) {
  const addonId = clean(selected?.addonId);
  const providerIndex = Number(selected?.providerIndex);
  if (!addonId || !Number.isInteger(providerIndex) || providerIndex < 0) {
    return { ok: false, reason: "stremio_index_selected_stream_identity_missing" };
  }

  let offset = 0;
  for (const slice of Array.isArray(slices) ? slices : []) {
    if (slice?.error) {
      return {
        ok: false,
        reason: "stremio_index_provider_query_failed",
        failedAddonId: slice.addonId || null,
        error: slice.error
      };
    }

    const streams = Array.isArray(slice?.streams) ? slice.streams : [];
    if (clean(slice?.addonId) === addonId) {
      const matches = [];
      streams.forEach((entry, index) => {
        if (Number(entry?.providerIndex) === providerIndex) matches.push(index);
      });
      if (matches.length !== 1) {
        return {
          ok: false,
          reason: matches.length ? "stremio_index_selected_stream_ambiguous" : "stremio_index_selected_stream_not_found",
          addonId,
          providerIndex
        };
      }
      const index = offset + matches[0];
      if (index > maxIndex) {
        return { ok: false, reason: "stremio_index_exceeds_safe_limit", index, maxIndex };
      }
      return {
        ok: true,
        confidence: "exact_account_order_and_provider_index",
        index,
        addonId,
        providerIndex,
        providersBefore: slices.findIndex((entry) => clean(entry?.addonId) === addonId),
        streamsBefore: offset,
        navigation: "horizontal_right"
      };
    }
    offset += streams.length;
  }

  return { ok: false, reason: "stremio_index_selected_addon_not_in_account", addonId };
}

function accountFor(client) {
  return client?.__stremioSmartRuntime?.account
    || client?.__stremioFamilyAccountProviderState?.account
    || null;
}

function streamAccountAddons(account) {
  return (Array.isArray(account?.addons) ? account.addons : [])
    .filter((addon) => addon
      && Array.isArray(addon.roles)
      && addon.roles.includes("stream")
      && clean(addon.id)
      && clean(addon.transportUrl));
}

function makeSingleAddonAggregator(client, transportUrl) {
  const aggregator = new StremioAddonAggregator({
    manifestUrls: [transportUrl],
    timeoutMs: client.stremioAddonTimeoutMs || client.stremioTimeoutMs || 20000
  });
  installStremioAddonCompatibilityPatch(aggregator, {
    retries: client.stremioAddonRetries || 0,
    preserveAddonOrder: true
  });
  return aggregator;
}

async function queryAccountProviderSlices(client, resolved, account) {
  const mediaType = clean(resolved?.type);
  const mediaId = clean(resolved?.videoId || resolved?.streamId || resolved?.id);
  if (!mediaType || !mediaId) return { mediaType, mediaId, addons: [], slices: [] };

  await account.refresh({ force: false });
  const addons = streamAccountAddons(account);
  const slices = await Promise.all(addons.map(async (addon) => {
    try {
      const aggregator = makeSingleAddonAggregator(client, addon.transportUrl);
      const result = await aggregator.getStreams(mediaType, mediaId);
      const error = result.errors?.[0]?.error || aggregator.errors?.[0]?.error || null;
      return {
        addonId: addon.id,
        addonName: addon.name,
        streams: result.streams || [],
        error
      };
    } catch (error) {
      return {
        addonId: addon.id,
        addonName: addon.name,
        streams: [],
        error: error?.message || String(error)
      };
    }
  }));

  return { mediaType, mediaId, addons, slices };
}


async function sendRemoteKey(client, command) {
  if (!client?.stremioRemoteEntityId) throw new Error("stremio_remote_entity_id_required");
  return client.haService("remote", "send_command", {
    entity_id: client.stremioRemoteEntityId,
    command: [command]
  });
}

export async function executeIndexedSelection(client, plan, {
  keyDelayMs = 250,
  initialFocusIndex = 1,
  centerDelayMs = keyDelayMs
} = {}) {
  if (!plan?.ok || !Number.isInteger(plan.index) || plan.index < 0) {
    return { ok: false, reason: "stremio_index_plan_required" };
  }

  const targetIndex = plan.index;
  const startIndex = Math.max(0, Number.isInteger(initialFocusIndex) ? initialFocusIndex : 0);
  const delta = targetIndex - startIndex;
  const movementCommand = delta >= 0 ? "DPAD_RIGHT" : "DPAD_LEFT";
  const movementCount = Math.abs(delta);
  const commands = [];

  try {
    for (let index = 0; index < movementCount; index += 1) {
      await sendRemoteKey(client, movementCommand);
      commands.push(movementCommand);
      if (keyDelayMs > 0 && index < movementCount - 1) await sleep(keyDelayMs);
    }
    if (centerDelayMs > 0) await sleep(centerDelayMs);
    const result = await sendRemoteKey(client, "DPAD_CENTER");
    commands.push("DPAD_CENTER");
    return {
      ok: true,
      via: "home_assistant_indexed_selection",
      navigation: delta >= 0 ? "horizontal_right" : "horizontal_left",
      targetIndex,
      initialFocusIndex: startIndex,
      requestedRights: targetIndex,
      forwardedRights: movementCommand === "DPAD_RIGHT" ? movementCount : 0,
      injectedLefts: movementCommand === "DPAD_LEFT" ? movementCount : 0,
      suppressedRights: Math.min(targetIndex, startIndex),
      keyDelayMs,
      centerDelayMs,
      centerSent: true,
      addonId: plan.addonId || null,
      providerIndex: plan.providerIndex ?? null,
      commands,
      result
    };
  } catch (error) {
    return {
      ok: false,
      via: "home_assistant_indexed_selection",
      navigation: delta >= 0 ? "horizontal_right" : "horizontal_left",
      targetIndex,
      initialFocusIndex: startIndex,
      requestedRights: targetIndex,
      forwardedRights: commands.filter((command) => command === "DPAD_RIGHT").length,
      injectedLefts: commands.filter((command) => command === "DPAD_LEFT").length,
      suppressedRights: Math.min(targetIndex, startIndex),
      keyDelayMs,
      centerDelayMs,
      centerSent: commands.includes("DPAD_CENTER"),
      commands,
      reason: error?.message || String(error)
    };
  }
}

async function playAccountWideLanguage(client, args = {}) {
  const env = client.env || process.env;
  const language = requestedLanguage(args);
  if (!language) return null;

  // Resolve metadata/history with the normal smart resolver, but force the provider
  // profile to default so the old isolated Family provider cannot block this path.
  const { resolved, streamId } = await client.resolveForStream({ ...args, profile: "default" });
  const account = accountFor(client);
  if (!account?.configured) {
    return {
      content: { type: resolved.type, id: resolved.id, videoId: resolved.videoId, selected: resolved.selected },
      deliveryMode: "accountwide_language_unavailable",
      playbackRequested: false,
      accountWideLanguageSelection: {
        ok: false,
        language,
        reason: "stremio_account_required_for_accountwide_language_selection"
      }
    };
  }

  const queried = await queryAccountProviderSlices(client, { ...resolved, streamId }, account);
  const choice = chooseNativeLanguageStream(queried.slices, { ...args, language });
  if (!choice.ok) {
    return {
      content: { type: resolved.type, id: resolved.id, videoId: resolved.videoId, selected: resolved.selected },
      preferences: client.streamPreferences(args),
      deliveryMode: "accountwide_language_no_match",
      playbackRequested: false,
      selected: null,
      accountWideLanguageSelection: {
        ...choice,
        providerCount: queried.addons.length,
        providerErrors: queried.slices.filter((slice) => slice.error).map((slice) => ({ addonId: slice.addonId, addonName: slice.addonName, error: slice.error }))
      }
    };
  }

  const plan = planFromProviderSlices(queried.slices, choice.selected, {
    maxIndex: numberEnv(env, "HA_SOL_STREMIO_INDEXED_MAX_INDEX", 100, 1, 200)
  });
  if (!plan.ok) {
    return {
      content: { type: resolved.type, id: resolved.id, videoId: resolved.videoId, selected: resolved.selected },
      preferences: client.streamPreferences(args),
      selected: choice.selected,
      deliveryMode: "accountwide_language_index_unproven",
      playbackRequested: false,
      indexedSelection: plan,
      accountWideLanguageSelection: {
        ...choice,
        providerCount: queried.addons.length,
        failClosed: true
      }
    };
  }

  const nativeLink = detailDeepLink({
    type: resolved.type,
    id: resolved.id,
    videoId: resolved.videoId || streamId || resolved.id,
    autoPlay: args.autoPlay === false ? false : true
  });
  const launch = await client.launchStremio(nativeLink);

  if (args.autoPlay === false) {
    return {
      content: { type: resolved.type, id: resolved.id, videoId: resolved.videoId, selected: resolved.selected },
      preferences: client.streamPreferences(args),
      selected: choice.selected,
      launch,
      deliveryMode: "accountwide_language_detail_opened",
      playbackRequested: false,
      indexedSelection: plan,
      accountWideLanguageSelection: { ...choice, providerCount: queried.addons.length }
    };
  }

  const timing = indexedNavigationTiming(env);
  const readiness = await waitForIndexedNavigation(env);
  if (readiness?.ready !== true) {
    return {
      content: { type: resolved.type, id: resolved.id, videoId: resolved.videoId, selected: resolved.selected },
      preferences: client.streamPreferences(args),
      selected: choice.selected,
      launch,
      deliveryMode: "accountwide_language_stream_ui_not_ready",
      playbackRequested: true,
      firstStreamClick: { ok: false, commandSent: false, reason: readiness?.reason || "stremio_stream_ui_not_ready", readiness },
      indexedSelection: plan,
      accountWideLanguageSelection: { ...choice, providerCount: queried.addons.length }
    };
  }

  const selection = await executeIndexedSelection(client, plan, timing);

  return {
    content: { type: resolved.type, id: resolved.id, videoId: resolved.videoId, selected: resolved.selected },
    preferences: client.streamPreferences(args),
    selected: choice.selected,
    launch,
    deliveryMode: selection.ok ? "accountwide_language_indexed_selection" : "accountwide_language_navigation_failed",
    playbackRequested: true,
    playbackConfirmed: null,
    playbackVerification: {
      status: "unverified",
      confirmed: null,
      via: "home_assistant_dpad_without_screen_observation",
      screenshotRequired: false
    },
    firstStreamClick: { ...selection, commandSent: selection.ok, readiness },
    indexedSelection: plan,
    accountWideLanguageSelection: {
      ...choice,
      providerCount: queried.addons.length,
      providerErrors: queried.slices.filter((slice) => slice.error).map((slice) => ({ addonId: slice.addonId, addonName: slice.addonName, error: slice.error })),
      failClosed: true
    }
  };
}

export function installStremioIndexedSelection(SolPluginClient) {
  const proto = SolPluginClient?.prototype;
  if (!proto || proto.__stremioIndexedSelectionInstalled) return SolPluginClient;
  proto.__stremioIndexedSelectionInstalled = true;

  const originalHandle = proto.handleStremioTool;
  const originalStatus = proto.stremioStatus;

  proto.stremioStatus = function stremioStatusWithIndexedSelection() {
    const env = this.env || process.env;
    return {
      ...originalStatus.call(this),
      indexedStreamSelection: {
        enabled: boolEnv(env, "HA_SOL_STREMIO_INDEXED_SELECTION", true),
        accountWideLanguageSelection: boolEnv(env, "HA_SOL_STREMIO_ACCOUNT_WIDE_LANGUAGE_SELECTION", true),
        transport: "Home Assistant remote.send_command only",
        navigation: "horizontal_relative_to_initial_focus",
        ...indexedNavigationTiming(env),
        maxIndex: numberEnv(env, "HA_SOL_STREMIO_INDEXED_MAX_INDEX", 100, 1, 200),
        failClosed: true,
        policy: "Spanish/Latin playback reconstructs the linked account's native stream order, compensates Stremio's initial focus, moves to the proven absolute index and only then sends DPAD_CENTER."
      }
    };
  };

  proto.handleStremioTool = async function handleStremioToolWithIndexedSelection(tool, args = {}) {
    const env = this.env || process.env;
    const playbackTool = tool === "home_assistant_stremio_play_best" || tool === "home_assistant_stremio_play";
    const enabled = boolEnv(env, "HA_SOL_STREMIO_INDEXED_SELECTION", true);
    const accountWide = boolEnv(env, "HA_SOL_STREMIO_ACCOUNT_WIDE_LANGUAGE_SELECTION", true);

    if (playbackTool && enabled && accountWide && requestedLanguage(args)) {
      return playAccountWideLanguage(this, args);
    }
    return originalHandle.call(this, tool, args);
  };

  return SolPluginClient;
}

export const __test = {
  accountFor,
  languageMatches,
  queryAccountProviderSlices,
  requestedLanguage,
  selectedLanguages,
  streamAccountAddons
};
