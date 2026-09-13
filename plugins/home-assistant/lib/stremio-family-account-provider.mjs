import { StremioAccountClient } from "./stremio-account.mjs";
import { StremioAddonAggregator } from "./stremio-addons.mjs";
import { installStremioAddonCompatibilityPatch } from "./stremio-addon-compat.mjs";

const PROFILE_TOOLS = new Set([
  "home_assistant_stremio_resolve",
  "home_assistant_stremio_addons",
  "home_assistant_stremio_streams",
  "home_assistant_stremio_select_stream",
  "home_assistant_stremio_play_best",
  "home_assistant_stremio_play"
]);

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

function selectedAddonId(env) {
  const value = clean(env?.HA_SOL_STREMIO_FAMILY_ACCOUNT_ADDON_ID);
  return !value || value === "manual" ? "" : value;
}

function createAccount(env) {
  return new StremioAccountClient({
    enabled: boolEnv(env, "HA_SOL_STREMIO_ACCOUNT_ENABLED", false),
    authKey: env.HA_SOL_STREMIO_ACCOUNT_AUTH_KEY || "",
    email: env.HA_SOL_STREMIO_ACCOUNT_EMAIL || "",
    password: env.HA_SOL_STREMIO_ACCOUNT_PASSWORD || "",
    timeoutMs: numberEnv(env, "HA_SOL_STREMIO_ACCOUNT_TIMEOUT_MS", 12000, 1000, 30000),
    refreshMs: numberEnv(env, "HA_SOL_STREMIO_ACCOUNT_REFRESH_MS", 60000, 5000, 3600000)
  });
}

function createFamilyAggregator(client, transportUrl) {
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

export function findSelectedStreamAddon(addons, addonId) {
  const wanted = clean(addonId);
  if (!wanted) return null;
  return (Array.isArray(addons) ? addons : []).find((addon) =>
    addon && clean(addon.id) === wanted && Array.isArray(addon.roles) && addon.roles.includes("stream") && clean(addon.transportUrl)
  ) || null;
}

async function ensureFamilyAccountProvider(client) {
  const env = client?.env || process.env;
  const addonId = selectedAddonId(env);
  if (!addonId) return { source: "manual", addonId: null };

  const runtime = client?.__stremioSmartRuntime;
  const state = client.__stremioFamilyAccountProviderState || {
    account: runtime?.account || createAccount(env),
    addonId: null,
    transportUrl: null,
    resolvedAt: 0
  };
  client.__stremioFamilyAccountProviderState = state;
  if (runtime?.account && state.account !== runtime.account) state.account = runtime.account;

  if (!state.account?.configured) throw new Error("stremio_family_account_credentials_required");
  const freshEnough = state.addonId === addonId && state.transportUrl && Date.now() - state.resolvedAt < 60000;
  if (!freshEnough) {
    await state.account.refresh({ force: false });
    const addon = findSelectedStreamAddon(state.account.addons, addonId);
    if (!addon) throw new Error(`stremio_family_account_addon_not_found:${addonId}`);
    state.addonId = addonId;
    state.transportUrl = addon.transportUrl;
    state.resolvedAt = Date.now();
  }

  // If smart playback has not initialized yet, this makes its existing family
  // aggregator use only the selected account add-on. Never expose this URL in results.
  env.HA_SOL_STREMIO_FAMILY_ADDONS = state.transportUrl;
  process.env.HA_SOL_STREMIO_FAMILY_ADDONS = state.transportUrl;

  if (runtime) {
    runtime.familyAggregator = createFamilyAggregator(client, state.transportUrl);
    runtime.familyConfigError = null;
    runtime.familyEnabled = true;
  }
  return { source: "stremio_account", addonId };
}

export function installStremioFamilyAccountProvider(SolPluginClient) {
  const proto = SolPluginClient?.prototype;
  if (!proto || proto.__stremioFamilyAccountProviderInstalled) return SolPluginClient;
  proto.__stremioFamilyAccountProviderInstalled = true;

  const originalHandle = proto.handleStremioTool;
  proto.handleStremioTool = async function handleStremioToolWithFamilyAccountProvider(tool, args = {}) {
    const profile = clean(args.profile || "auto").toLowerCase();
    if (PROFILE_TOOLS.has(tool) && profile === "family") {
      await ensureFamilyAccountProvider(this);
    }
    return originalHandle.call(this, tool, args);
  };
  return SolPluginClient;
}

export const __test = {
  selectedAddonId,
  findSelectedStreamAddon
};
