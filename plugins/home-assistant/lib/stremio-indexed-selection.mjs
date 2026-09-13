import { StremioAddonAggregator } from "./stremio-addons.mjs";
import { installStremioAddonCompatibilityPatch } from "./stremio-addon-compat.mjs";

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

function selectedLanguages(selected) {
  return Array.isArray(selected?.languages)
    ? selected.languages.map((value) => clean(value).toLowerCase()).filter(Boolean)
    : [];
}

export function requiresExactLanguageSelection(selected, args = {}) {
  const requested = clean(args?.language || "any").toLowerCase();
  if (requested === "latin" || requested === "spanish") return true;
  const languages = selectedLanguages(selected);
  return languages.includes("latin") || languages.includes("spanish");
}

export function planFromProviderSlices(slices, selected, { maxIndex = 30 } = {}) {
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
        confidence: "exact_addon_and_provider_index",
        index,
        addonId,
        providerIndex,
        providersBefore: slices.findIndex((entry) => clean(entry?.addonId) === addonId),
        streamsBefore: offset
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

async function computeAccountIndexPlan(client, resolved, selected, { maxIndex = 30 } = {}) {
  const account = accountFor(client);
  if (!account?.configured) return { ok: false, reason: "stremio_index_account_not_configured" };

  const mediaType = clean(resolved?.type);
  const mediaId = clean(resolved?.videoId || resolved?.id);
  if (!mediaType || !mediaId) return { ok: false, reason: "stremio_index_content_identity_missing" };

  await account.refresh({ force: false });
  const addons = streamAccountAddons(account);
  const selectedAddonId = clean(selected?.addonId);
  const selectedAddonPosition = addons.findIndex((addon) => clean(addon.id) === selectedAddonId);
  if (selectedAddonPosition < 0) {
    return { ok: false, reason: "stremio_index_selected_addon_not_in_account", addonId: selectedAddonId || null };
  }

  // Query only the providers that can affect the absolute position. Any failure
  // before (or at) the selected provider makes the predicted index unsafe.
  const relevant = addons.slice(0, selectedAddonPosition + 1);
  const slices = [];
  for (const addon of relevant) {
    try {
      const aggregator = makeSingleAddonAggregator(client, addon.transportUrl);
      const result = await aggregator.getStreams(mediaType, mediaId);
      slices.push({ addonId: addon.id, addonName: addon.name, streams: result.streams || [], error: result.errors?.[0]?.error || null });
    } catch (error) {
      slices.push({ addonId: addon.id, addonName: addon.name, streams: [], error: error?.message || String(error) });
    }
  }

  return {
    ...planFromProviderSlices(slices, selected, { maxIndex }),
    mediaType,
    mediaId,
    accountProviderCount: addons.length,
    queriedProviderCount: relevant.length
  };
}

async function sendRemoteKey(client, command) {
  if (!client?.stremioRemoteEntityId) throw new Error("stremio_remote_entity_id_required");
  return client.haService("remote", "send_command", {
    entity_id: client.stremioRemoteEntityId,
    command: [command]
  });
}

export async function executeIndexedSelection(client, plan, { keyDelayMs = 180 } = {}) {
  if (!plan?.ok || !Number.isInteger(plan.index) || plan.index < 0) {
    return { ok: false, reason: "stremio_index_plan_required" };
  }
  const commands = [];
  try {
    for (let index = 0; index < plan.index; index += 1) {
      await sendRemoteKey(client, "DPAD_DOWN");
      commands.push("DPAD_DOWN");
      if (keyDelayMs > 0) await sleep(keyDelayMs);
    }
    const result = await sendRemoteKey(client, "DPAD_CENTER");
    commands.push("DPAD_CENTER");
    return {
      ok: true,
      via: "home_assistant_indexed_selection",
      satelliteUsed: false,
      index: plan.index,
      addonId: plan.addonId || null,
      providerIndex: plan.providerIndex ?? null,
      commands,
      result
    };
  } catch (error) {
    return {
      ok: false,
      via: "home_assistant_indexed_selection",
      satelliteUsed: false,
      index: plan.index,
      commands,
      reason: error?.message || String(error)
    };
  }
}

export function installStremioIndexedSelection(SolPluginClient) {
  const proto = SolPluginClient?.prototype;
  if (!proto || proto.__stremioIndexedSelectionInstalled) return SolPluginClient;
  proto.__stremioIndexedSelectionInstalled = true;

  const originalHandle = proto.handleStremioTool;
  const originalResolveForStream = proto.resolveForStream;
  const originalVisualSelect = proto.autoSelectVisualStream;
  const originalClickFirst = proto.clickFirstStream;
  const originalStatus = proto.stremioStatus;

  proto.stremioStatus = function stremioStatusWithIndexedSelection() {
    const env = this.env || process.env;
    return {
      ...originalStatus.call(this),
      indexedStreamSelection: {
        enabled: boolEnv(env, "HA_SOL_STREMIO_INDEXED_SELECTION", true),
        transport: "Home Assistant remote.send_command only",
        satelliteUsed: false,
        keyDelayMs: numberEnv(env, "HA_SOL_STREMIO_INDEXED_KEY_DELAY_MS", 180, 0, 1000),
        maxIndex: numberEnv(env, "HA_SOL_STREMIO_INDEXED_MAX_INDEX", 30, 1, 100),
        policy: "Reconstruct the selected account-addon stream index and send DPAD_DOWN x index then DPAD_CENTER. Spanish/Latin selections fail closed when the index cannot be proven."
      }
    };
  };

  proto.resolveForStream = async function resolveForStreamWithIndexCapture(...args) {
    const result = await originalResolveForStream.apply(this, args);
    const context = this.__stremioIndexedSelectionContext;
    if (context?.active && result && typeof result === "object") {
      context.resolved = result;
    }
    return result;
  };

  proto.autoSelectVisualStream = async function autoSelectVisualStreamWithIndexPlan(selected) {
    const context = this.__stremioIndexedSelectionContext;
    const env = this.env || process.env;
    if (context?.active && boolEnv(env, "HA_SOL_STREMIO_INDEXED_SELECTION", true)) {
      context.selected = selected || null;
      context.strictLanguage = requiresExactLanguageSelection(selected, context.args);
      if (!context.plan && context.resolved && selected) {
        try {
          context.plan = await computeAccountIndexPlan(this, context.resolved, selected, {
            maxIndex: numberEnv(env, "HA_SOL_STREMIO_INDEXED_MAX_INDEX", 30, 1, 100)
          });
        } catch (error) {
          context.plan = { ok: false, reason: error?.message || String(error) };
        }
      }
    }
    return originalVisualSelect.call(this, selected);
  };

  proto.clickFirstStream = async function clickFirstStreamWithIndexedSelection(...args) {
    const context = this.__stremioIndexedSelectionContext;
    const env = this.env || process.env;
    if (!context?.active || !boolEnv(env, "HA_SOL_STREMIO_INDEXED_SELECTION", true)) {
      return originalClickFirst.apply(this, args);
    }

    const guard = this.__stremioLaunchGuardContext?.last;
    if (guard && guard.allowStreamInput === false) {
      return { ok: false, commandSent: false, reason: "stremio_launch_guard_blocked_stream_input", launchGuard: guard };
    }

    if (context.plan?.ok) {
      const readiness = await this.waitForStreamUi();
      if (readiness?.alreadyPlaying) {
        return { ok: true, skipped: true, reason: "stremio_player_already_visible", readiness, indexedSelection: context.plan };
      }
      if (readiness?.ready !== true) {
        return { ok: false, commandSent: false, reason: readiness?.reason || "stremio_stream_ui_not_ready", readiness, indexedSelection: context.plan };
      }
      const selection = await executeIndexedSelection(this, context.plan, {
        keyDelayMs: numberEnv(env, "HA_SOL_STREMIO_INDEXED_KEY_DELAY_MS", 180, 0, 1000)
      });
      return {
        ...selection,
        commandSent: selection.ok,
        readiness,
        indexedSelection: context.plan,
        exactLanguageSelection: Boolean(context.strictLanguage)
      };
    }

    if (context.strictLanguage) {
      return {
        ok: false,
        commandSent: false,
        reason: context.plan?.reason || "stremio_exact_language_index_unavailable",
        indexedSelection: context.plan || null,
        exactLanguageSelection: true,
        note: "Spanish/Latin was selected by SOL but the native Stremio row index could not be proven, so no generic CENTER was sent."
      };
    }

    return originalClickFirst.apply(this, args);
  };

  proto.handleStremioTool = async function handleStremioToolWithIndexedSelection(tool, args = {}) {
    if (!["home_assistant_stremio_play_best", "home_assistant_stremio_play"].includes(tool)) {
      return originalHandle.call(this, tool, args);
    }
    const previous = this.__stremioIndexedSelectionContext;
    const context = {
      active: true,
      tool,
      args: { ...args },
      resolved: null,
      selected: null,
      strictLanguage: clean(args?.language).toLowerCase() === "latin" || clean(args?.language).toLowerCase() === "spanish",
      plan: null
    };
    this.__stremioIndexedSelectionContext = context;
    try {
      const result = await originalHandle.call(this, tool, args);
      return result && typeof result === "object"
        ? {
            ...result,
            indexedSelection: context.plan || {
              ok: false,
              reason: context.selected ? "stremio_index_plan_not_computed" : "stremio_selected_stream_not_observed"
            }
          }
        : result;
    } finally {
      this.__stremioIndexedSelectionContext = previous;
    }
  };

  return SolPluginClient;
}

export const __test = {
  computeAccountIndexPlan,
  streamAccountAddons,
  selectedLanguages
};
