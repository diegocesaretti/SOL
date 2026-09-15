import { inspectStream, summarizeRankedStream } from "./stremio-addons.mjs";
import { queryProviderStreams } from "./stremio-provider-query.mjs";

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
  const keyDelayMs = numberEnv(env, "HA_SOL_STREMIO_INDEXED_KEY_DELAY_MS", 250, 0, 2000);
  return {
    openToKeysDelayMs: numberEnv(env, "HA_SOL_STREMIO_OPEN_TO_KEYS_DELAY_MS", 1500, 0, 60000),
    keyDelayMs,
    initialFocusIndex: 0,
    resetBeforeNavigation: boolEnv(env, "HA_SOL_STREMIO_RESET_BEFORE_NAVIGATION", false),
    resetLeftHoldMs: 7000,
    resetPostDownDelayMs: 1000,
    centerDelayMs: numberEnv(env, "HA_SOL_STREMIO_INDEXED_CENTER_DELAY_MS", keyDelayMs, 0, 10000),
    centerCommand: ["DPAD_CENTER", "ENTER"].includes(clean(env?.HA_SOL_STREMIO_INDEXED_CENTER_COMMAND).toUpperCase())
      ? clean(env.HA_SOL_STREMIO_INDEXED_CENTER_COMMAND).toUpperCase()
      : "DPAD_CENTER",
    centerHoldMs: numberEnv(env, "HA_SOL_STREMIO_INDEXED_CENTER_HOLD_MS", 120, 0, 1000)
  };
}

export async function waitForIndexedNavigation(env = process.env) {
  const timing = indexedNavigationTiming(env);
  if (timing.openToKeysDelayMs > 0) await sleep(timing.openToKeysDelayMs);
  return timing;
}

function requestedResolution(value) {
  const text = clean(value).toLowerCase();
  if (!text || text === "auto" || text === "any") return null;
  if (["4k", "2160", "2160p"].includes(text)) return 2160;
  const parsed = Number(text.replace(/p$/, ""));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function languageMatches(details, language) {
  if (!language || language === "any") return true;
  const languages = Array.isArray(details?.languages)
    ? details.languages.map((value) => clean(value).toLowerCase())
    : [];
  if (language === "latin") return languages.includes("latin");
  if (language === "spanish") return languages.includes("spanish") || languages.includes("latin");
  if (language === "english") return languages.includes("english");
  return true;
}

function preferSubset(candidates, predicate) {
  const subset = candidates.filter(predicate);
  return subset.length ? subset : candidates;
}

function preferLatinSignal(candidates, language) {
  if (!["latin", "spanish"].includes(language) || !candidates.length) return candidates;
  const highest = Math.max(...candidates.map((candidate) => Number(candidate?.details?.latinPriority) || 0));
  if (highest <= 0) return candidates;
  return candidates.filter((candidate) => (Number(candidate?.details?.latinPriority) || 0) === highest);
}

export function chooseNativeStream(slices, preferences = {}) {
  const candidates = [];
  let nativeIndex = 0;
  for (const slice of Array.isArray(slices) ? slices : []) {
    const streams = Array.isArray(slice?.streams) ? slice.streams : [];
    for (const entry of streams) {
      const details = entry?.details || inspectStream(entry?.stream || {});
      candidates.push({
        entry,
        details,
        nativeIndex,
        addonId: clean(slice?.addonId || entry?.addon?.id),
        addonName: clean(slice?.addonName || entry?.addon?.name) || null,
        providerIndex: Number(entry?.providerIndex)
      });
      nativeIndex += 1;
    }
  }

  if (!candidates.length) return { ok: false, reason: "stremio_account_no_streams", scannedStreamCount: 0 };

  const language = clean(preferences.language || "any").toLowerCase();
  let preferred = language === "any"
    ? candidates
    : candidates.filter((candidate) => languageMatches(candidate.details, language));
  if (!preferred.length) {
    return {
      ok: false,
      reason: `stremio_account_no_${language || "requested"}_streams`,
      language,
      scannedStreamCount: nativeIndex
    };
  }

  preferred = preferLatinSignal(preferred, language);
  const resolution = requestedResolution(preferences.quality);
  if (resolution) preferred = preferSubset(preferred, (candidate) => candidate.details.quality === resolution);
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
    selected,
    nativeIndex: chosen.nativeIndex,
    matchingCount: preferred.length,
    scannedStreamCount: nativeIndex,
    language
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
      if (index > maxIndex) return { ok: false, reason: "stremio_index_exceeds_safe_limit", index, maxIndex };
      return {
        ok: true,
        confidence: "exact_account_order_and_provider_index",
        index,
        addonId,
        providerIndex,
        streamsBefore: offset
      };
    }
    offset += streams.length;
  }
  return { ok: false, reason: "stremio_index_selected_addon_not_in_account", addonId };
}

function resourceDescriptors(manifest) {
  return (Array.isArray(manifest?.resources) ? manifest.resources : [])
    .map((resource) => typeof resource === "string" ? { name: resource } : resource)
    .filter((resource) => resource && typeof resource === "object");
}

export function accountAddonSupportsStream(addon, mediaType, mediaId) {
  const manifest = addon?.manifest;
  if (!manifest || typeof manifest !== "object") return true;
  for (const resource of resourceDescriptors(manifest)) {
    if (resource.name !== "stream") continue;
    const types = Array.isArray(resource.types) ? resource.types
      : Array.isArray(manifest.types) ? manifest.types
        : [];
    if (types.length && !types.map(String).includes(String(mediaType))) continue;
    const prefixes = Array.isArray(resource.idPrefixes) ? resource.idPrefixes
      : Array.isArray(manifest.idPrefixes) ? manifest.idPrefixes
        : [];
    if (prefixes.length && !prefixes.some((prefix) => String(mediaId).startsWith(String(prefix)))) continue;
    return true;
  }
  return false;
}

function streamAccountAddons(account, mediaType, mediaId) {
  return (Array.isArray(account?.addons) ? account.addons : [])
    .filter((addon) => addon
      && Array.isArray(addon.roles)
      && addon.roles.includes("stream")
      && clean(addon.id)
      && clean(addon.transportUrl)
      && accountAddonSupportsStream(addon, mediaType, mediaId));
}

export async function queryAccountProviderSlices(client, { mediaType, mediaId }, account) {
  if (!mediaType || !mediaId) return { addons: [], slices: [] };
  await account.refresh({ force: false });
  const addons = streamAccountAddons(account, mediaType, mediaId);
  const slices = await Promise.all(addons.map(async (addon) => {
    try {
      const result = await queryProviderStreams({
        manifestUrl: addon.transportUrl,
        mediaType,
        mediaId,
        timeoutMs: client.stremioAddonTimeoutMs || 20000,
        retries: client.stremioAddonRetries || 1
      });
      return {
        addonId: addon.id,
        addonName: addon.name,
        streams: result.streams.map((stream, providerIndex) => ({
          addon: { id: addon.id, name: addon.name },
          stream,
          providerIndex
        })),
        error: result.error,
        attempts: result.attempts
      };
    } catch (error) {
      return {
        addonId: addon.id,
        addonName: addon.name,
        streams: [],
        error: error?.message || String(error),
        attempts: []
      };
    }
  }));
  return { addons, slices };
}

async function sendRemoteKey(client, command, holdMs = 0) {
  if (!client?.stremioRemoteEntityId) throw new Error("stremio_remote_entity_id_required");
  const payload = {
    entity_id: client.stremioRemoteEntityId,
    command
  };
  if (holdMs > 0) payload.hold_secs = holdMs / 1000;
  return client.haService("remote", "send_command", payload);
}

export async function executeIndexedSelection(client, plan, {
  keyDelayMs = 250,
  initialFocusIndex = 0,
  resetBeforeNavigation = false,
  resetLeftHoldMs = 7000,
  resetPostDownDelayMs = 1000,
  centerDelayMs = keyDelayMs,
  centerCommand = "DPAD_CENTER",
  centerHoldMs = 120
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
  const resetCommands = [];

  try {
    if (resetBeforeNavigation) {
      await sendRemoteKey(client, "DPAD_LEFT", resetLeftHoldMs);
      commands.push("DPAD_LEFT");
      resetCommands.push("DPAD_LEFT");

      await sendRemoteKey(client, "DPAD_RIGHT");
      commands.push("DPAD_RIGHT");
      resetCommands.push("DPAD_RIGHT");

      await sendRemoteKey(client, "DPAD_DOWN");
      commands.push("DPAD_DOWN");
      resetCommands.push("DPAD_DOWN");

      if (resetPostDownDelayMs > 0) await sleep(resetPostDownDelayMs);
    }

    for (let index = 0; index < movementCount; index += 1) {
      await sendRemoteKey(client, movementCommand);
      commands.push(movementCommand);
      if (keyDelayMs > 0 && index < movementCount - 1) await sleep(keyDelayMs);
    }
    if (centerDelayMs > 0) await sleep(centerDelayMs);
    const result = await sendRemoteKey(client, centerCommand, centerHoldMs);
    commands.push(centerCommand);
    return {
      ok: true,
      via: "home_assistant_indexed_selection",
      targetIndex,
      initialFocusIndex: startIndex,
      movementCommand,
      movementCount,
      keyDelayMs,
      resetBeforeNavigation,
      resetLeftHoldMs: resetBeforeNavigation ? resetLeftHoldMs : 0,
      resetPostDownDelayMs: resetBeforeNavigation ? resetPostDownDelayMs : 0,
      resetCommands,
      centerDelayMs,
      centerCommand,
      centerHoldMs,
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
      targetIndex,
      initialFocusIndex: startIndex,
      movementCommand,
      movementCount,
      keyDelayMs,
      resetBeforeNavigation,
      resetLeftHoldMs: resetBeforeNavigation ? resetLeftHoldMs : 0,
      resetPostDownDelayMs: resetBeforeNavigation ? resetPostDownDelayMs : 0,
      resetCommands,
      centerDelayMs,
      centerCommand,
      centerHoldMs,
      centerSent: commands.includes(centerCommand),
      commands,
      reason: error?.message || String(error)
    };
  }
}
