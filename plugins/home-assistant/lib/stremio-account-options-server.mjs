import { createServer } from "node:http";
import { StremioAccountClient } from "./stremio-account.mjs";

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

function sendJson(response, status, value) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

export function streamAddonOptions(addons = []) {
  return (Array.isArray(addons) ? addons : [])
    .filter((addon) => addon && Array.isArray(addon.roles) && addon.roles.includes("stream") && clean(addon.id))
    .map((addon) => ({
      value: clean(addon.id),
      label: `${clean(addon.name || addon.id)} · ${clean(addon.id)}`
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "es"));
}

function accountFromEnv(env) {
  return new StremioAccountClient({
    enabled: boolEnv(env, "HA_SOL_STREMIO_ACCOUNT_ENABLED", false),
    authKey: env.HA_SOL_STREMIO_ACCOUNT_AUTH_KEY || "",
    email: env.HA_SOL_STREMIO_ACCOUNT_EMAIL || "",
    password: env.HA_SOL_STREMIO_ACCOUNT_PASSWORD || "",
    timeoutMs: numberEnv(env, "HA_SOL_STREMIO_ACCOUNT_TIMEOUT_MS", 12000, 1000, 30000),
    refreshMs: numberEnv(env, "HA_SOL_STREMIO_ACCOUNT_REFRESH_MS", 60000, 5000, 3600000)
  });
}

export function startStremioAccountOptionsServer(env = process.env) {
  const port = numberEnv(env, "HA_SOL_STREMIO_OPTIONS_PORT", 8768, 1024, 65535);
  const account = accountFromEnv(env);
  const server = createServer(async (request, response) => {
    const path = new URL(request.url || "/", "http://127.0.0.1").pathname;
    if (request.method !== "GET" || path !== "/options/stremio-stream-addons") {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (!account.configured) {
      sendJson(response, 200, { options: [], connected: false, reason: "stremio_account_not_configured" });
      return;
    }
    try {
      await account.refresh({ force: true });
      sendJson(response, 200, {
        options: streamAddonOptions(account.safeAddons()),
        connected: true,
        refreshedAt: new Date().toISOString()
      });
    } catch (error) {
      sendJson(response, 200, {
        options: [],
        connected: false,
        reason: error?.message || String(error)
      });
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Stremio account setting options listening on loopback port ${port}`);
  });
  server.unref?.();
  return server;
}
