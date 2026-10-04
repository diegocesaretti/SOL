import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const API_BASE = "https://api.mercadolibre.com";
const AUTH_BASE = "https://auth.mercadolibre.com.ar/authorization";
const MAX_BINARY_BYTES = 12 * 1024 * 1024;

function safeInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function cleanObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

function appendQuery(url, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else if (typeof value === "boolean") {
      params.set(key, value ? "true" : "false");
    } else {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? url + (url.includes("?") ? "&" : "?") + qs : url;
}

function requireApiPath(path) {
  const value = String(path || "").trim();
  if (!value.startsWith("/")) throw new Error("mercadolibre_api_path_must_start_with_slash");
  if (value.startsWith("//") || /^\/https?:/i.test(value)) throw new Error("mercadolibre_external_url_not_allowed");
  return value;
}

function safeHeaders(headers = {}) {
  const blocked = new Set(["authorization", "host", "cookie", "set-cookie", "content-length", "proxy-authorization"]);
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = String(key).toLowerCase();
    if (blocked.has(lower)) continue;
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
}

function errorFromPayload(status, payload, requestId) {
  const detail =
    payload?.message ||
    payload?.error ||
    payload?.cause?.[0]?.message ||
    (typeof payload === "string" ? payload : "") ||
    "Mercado Libre HTTP " + status;
  const error = new Error(detail);
  error.status = status;
  error.payload = payload;
  error.requestId = requestId || null;
  return error;
}

async function atomicWrite(path, content) {
  const temp = path + "." + process.pid + "." + Date.now() + ".tmp";
  await writeFile(temp, content, "utf8");
  await rename(temp, path);
}

async function runPowerShell(script, input = "") {
  const exe = (process.env.SystemRoot || "C:\\Windows") + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  return await new Promise((resolve, reject) => {
    const child = spawn(exe, ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (x) => { out += x; });
    child.stderr.on("data", (x) => { err += x; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error("powershell_failed:" + (err.trim() || code)));
    });
    child.stdin.end(input);
  });
}

class DpapiTokenStore {
  constructor(dataDir) {
    this.path = join(dataDir, "mercadolibre-seller-token.dpapi");
  }

  async save(value) {
    const json = JSON.stringify(value);
    const script = [
      "$plain=[Console]::In.ReadToEnd();",
      "$bytes=[Text.Encoding]::UTF8.GetBytes($plain);",
      "$enc=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
      "[Console]::Out.Write([Convert]::ToBase64String($enc));"
    ].join(" ");
    const encrypted = await runPowerShell(script, json);
    await atomicWrite(this.path, encrypted);
  }

  async load() {
    let encrypted;
    try {
      encrypted = (await readFile(this.path, "utf8")).trim();
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (!encrypted) return null;
    const script = [
      "$b64=[Console]::In.ReadToEnd().Trim();",
      "$enc=[Convert]::FromBase64String($b64);",
      "$bytes=[Security.Cryptography.ProtectedData]::Unprotect($enc,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
      "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes));"
    ].join(" ");
    const json = await runPowerShell(script, encrypted);
    return JSON.parse(json);
  }

  async clear() {
    await rm(this.path, { force: true });
  }
}

export function createMercadoLibreApi({ dataDir, site = "MLA", clientId = "", clientSecret = "", redirectUri = "", allowWrite = false, pkce = false } = {}) {
  const tokenStore = new DpapiTokenStore(dataDir);
  const oauthStatePath = join(dataDir, "mercadolibre-oauth-state.json");
  let refreshPromise = null;

  function configured() {
    return Boolean(clientId && clientSecret && redirectUri);
  }

  function requireConfigured() {
    if (!clientId) throw new Error("mercadolibre_client_id_required");
    if (!clientSecret) throw new Error("mercadolibre_client_secret_required");
    if (!redirectUri) throw new Error("mercadolibre_redirect_uri_required");
  }

  async function saveOauthState(value) {
    await mkdir(dataDir, { recursive: true });
    await atomicWrite(oauthStatePath, JSON.stringify(value, null, 2));
  }

  async function loadOauthState() {
    try {
      return JSON.parse(await readFile(oauthStatePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function openUrl(url) {
    if (process.platform !== "win32") return false;
    const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
      windowsHide: true,
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    return true;
  }

  async function oauthStatus() {
    let token = null;
    let tokenError = null;
    try {
      token = await tokenStore.load();
    } catch (error) {
      tokenError = error?.message || String(error);
    }
    const expiresAtMs = Date.parse(token?.expires_at || "");
    return {
      configured: configured(),
      clientIdConfigured: Boolean(clientId),
      clientSecretConfigured: Boolean(clientSecret),
      redirectUriConfigured: Boolean(redirectUri),
      redirectUri: redirectUri || null,
      site,
      pkce: Boolean(pkce),
      authenticated: Boolean(token?.access_token),
      userId: token?.user_id ?? null,
      expiresAt: token?.expires_at ?? null,
      expiresInSeconds: Number.isFinite(expiresAtMs) ? Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000)) : null,
      refreshTokenPresent: Boolean(token?.refresh_token),
      tokenStorage: process.platform === "win32" ? "windows-dpapi-current-user" : "unsupported",
      tokenError
    };
  }

  async function beginLogin({ openBrowser = true } = {}) {
    requireConfigured();
    await mkdir(dataDir, { recursive: true });
    const state = randomBytes(24).toString("base64url");
    const record = {
      state,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    };

    const url = new URL(AUTH_BASE);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);

    if (pkce) {
      const verifier = randomBytes(48).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      record.code_verifier = verifier;
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
    }

    await saveOauthState(record);
    const browserOpened = openBrowser ? await openUrl(url.toString()) : false;
    return {
      ok: true,
      browserOpened,
      authorizationUrl: url.toString(),
      state,
      redirectUri,
      expiresAt: record.expires_at,
      instructions: "Autoriza BWA 3D en Mercado Libre. Luego completa el login con el code o pegando la URL final de redireccion."
    };
  }

  async function tokenRequest(params) {
    const response = await fetch(API_BASE + "/oauth/token", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(30000)
    });
    const payload = await response.json().catch(async () => await response.text().catch(() => ""));
    if (!response.ok) throw errorFromPayload(response.status, payload, response.headers.get("x-request-id"));
    return payload;
  }

  async function persistToken(payload, previous = null) {
    const obtainedAt = new Date();
    const expiresIn = safeInt(payload?.expires_in, 21600, 60, 7 * 24 * 60 * 60);
    const token = {
      access_token: payload?.access_token || previous?.access_token || "",
      token_type: payload?.token_type || previous?.token_type || "Bearer",
      expires_in: expiresIn,
      scope: payload?.scope ?? previous?.scope ?? null,
      user_id: payload?.user_id ?? previous?.user_id ?? null,
      refresh_token: payload?.refresh_token || previous?.refresh_token || "",
      obtained_at: obtainedAt.toISOString(),
      expires_at: new Date(obtainedAt.getTime() + expiresIn * 1000).toISOString()
    };
    if (!token.access_token) throw new Error("mercadolibre_access_token_missing");
    await tokenStore.save(token);
    return token;
  }

  async function completeLogin({ code, redirectUrl, state } = {}) {
    requireConfigured();
    let authorizationCode = String(code || "").trim();
    let returnedState = String(state || "").trim();

    if (redirectUrl) {
      const parsed = new URL(String(redirectUrl));
      authorizationCode ||= parsed.searchParams.get("code") || "";
      returnedState ||= parsed.searchParams.get("state") || "";
      const oauthError = parsed.searchParams.get("error");
      if (oauthError) throw new Error("mercadolibre_oauth_error:" + oauthError);
    }

    if (!authorizationCode) throw new Error("mercadolibre_authorization_code_required");
    const pending = await loadOauthState();
    if (!pending?.state) throw new Error("mercadolibre_oauth_state_missing");
    if (Date.parse(pending.expires_at || "") < Date.now()) throw new Error("mercadolibre_oauth_state_expired");
    if (!returnedState || returnedState !== pending.state) throw new Error("mercadolibre_oauth_state_mismatch");

    const params = {
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code: authorizationCode,
      redirect_uri: redirectUri
    };
    if (pending.code_verifier) params.code_verifier = pending.code_verifier;

    const payload = await tokenRequest(params);
    const token = await persistToken(payload);
    await rm(oauthStatePath, { force: true });

    const profilePath = token.user_id ? "/users/" + encodeURIComponent(String(token.user_id)) : "/users/me";
    const me = await request(profilePath, { authToken: token.access_token, retry401: false });
    if (me?.id && String(me.id) !== String(token.user_id || me.id)) {
      token.user_id = me.id;
      await tokenStore.save(token);
    }
    return {
      ok: true,
      authenticated: true,
      user: me,
      expiresAt: token.expires_at,
      refreshTokenPresent: Boolean(token.refresh_token)
    };
  }

  async function refresh() {
    if (refreshPromise) return await refreshPromise;
    refreshPromise = (async () => {
      requireConfigured();
      const previous = await tokenStore.load();
      if (!previous?.refresh_token) throw new Error("mercadolibre_refresh_token_missing");
      const payload = await tokenRequest({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: previous.refresh_token
      });
      return await persistToken(payload, previous);
    })();
    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }

  async function accessToken() {
    const token = await tokenStore.load();
    if (!token?.access_token) throw new Error("mercadolibre_seller_login_required");
    const expires = Date.parse(token.expires_at || "");
    if (!Number.isFinite(expires) || expires - Date.now() < 5 * 60 * 1000) {
      const refreshed = await refresh();
      return refreshed.access_token;
    }
    return token.access_token;
  }

  async function parseResponse(response) {
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("application/json") || contentType.includes("+json")) {
      return await response.json().catch(() => ({}));
    }
    if (contentType.startsWith("text/") || contentType.includes("xml") || contentType.includes("html")) {
      return await response.text().catch(() => "");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_BINARY_BYTES) {
      return { binary: true, contentType, size: bytes.byteLength, omitted: true };
    }
    return {
      binary: true,
      contentType: contentType || "application/octet-stream",
      size: bytes.byteLength,
      base64: Buffer.from(bytes).toString("base64")
    };
  }

  async function request(path, { method = "GET", query, body, headers = {}, retry401 = true, authToken } = {}) {
    const apiPath = requireApiPath(path);
    const token = authToken || await accessToken();
    const url = appendQuery(API_BASE + apiPath, query);
    const response = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        authorization: "Bearer " + token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...safeHeaders(headers)
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(45000)
    });
    const payload = await parseResponse(response);
    if (response.status === 401 && retry401 && !authToken) {
      const next = await refresh();
      return await request(apiPath, { method, query, body, headers, retry401: false, authToken: next.access_token });
    }
    if (!response.ok) throw errorFromPayload(response.status, payload, response.headers.get("x-request-id"));
    return payload;
  }

  async function logout() {
    await tokenStore.clear();
    await rm(oauthStatePath, { force: true });
    return { ok: true, loggedOut: true };
  }

  async function sellerId() {
    const token = await tokenStore.load();
    if (token?.user_id) return String(token.user_id);
    const profile = await request("/users/me");
    if (!profile?.id) throw new Error("mercadolibre_user_id_missing");
    if (token) {
      token.user_id = profile.id;
      await tokenStore.save(token);
    }
    return String(profile.id);
  }

  async function sellerProfile() {
    const id = await sellerId();
    return await request("/users/" + encodeURIComponent(id));
  }

  async function listItems(args = {}) {
    const id = await sellerId();
    const query = cleanObject({
      status: args.status,
      search_type: args.searchType,
      sku: args.sku,
      orders: args.orders,
      limit: safeInt(args.limit, 50, 1, 100),
      offset: safeInt(args.offset, 0, 0, 100000)
    });
    const listing = await request("/users/" + id + "/items/search", { query });
    if (!args.details) return listing;
    const ids = Array.isArray(listing?.results) ? listing.results.map(String) : [];
    const details = [];
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20);
      const rows = await request("/items/bulk", { query: { ids: chunk.join(",") } });
      if (Array.isArray(rows)) details.push(...rows);
      else details.push(rows);
    }
    return { ...listing, details };
  }

  async function getItem(itemId, { prices = false, salePrice = false } = {}) {
    const id = encodeURIComponent(String(itemId || "").trim());
    if (!id) throw new Error("mercadolibre_item_id_required");
    const reads = [request("/items/" + id)];
    if (prices) reads.push(request("/items/" + id + "/prices").catch((error) => ({ error: error.message, status: error.status || null })));
    if (salePrice) reads.push(request("/items/" + id + "/sale_price", { query: { context: "channel_marketplace" } }).catch((error) => ({ error: error.message, status: error.status || null })));
    const values = await Promise.all(reads);
    const result = { item: values[0] };
    let index = 1;
    if (prices) result.prices = values[index++];
    if (salePrice) result.salePrice = values[index++];
    return result;
  }

  async function updateItem(itemId, patch = {}) {
    if (!allowWrite) throw new Error("mercadolibre_write_disabled");
    const id = encodeURIComponent(String(itemId || "").trim());
    if (!id) throw new Error("mercadolibre_item_id_required");
    if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length) {
      throw new Error("mercadolibre_item_patch_required");
    }
    return await request("/items/" + id, { method: "PUT", body: patch });
  }

  async function listOrders(args = {}) {
    const id = await sellerId();
    return await request("/orders/search", {
      query: cleanObject({
        seller: id,
        "order.status": args.status,
        "order.date_created.from": args.from,
        "order.date_created.to": args.to,
        q: args.q,
        sort: args.sort || "date_desc",
        limit: safeInt(args.limit, 50, 1, 100),
        offset: safeInt(args.offset, 0, 0, 100000)
      })
    });
  }

  async function getOrder(orderId) {
    const id = encodeURIComponent(String(orderId || "").trim());
    if (!id) throw new Error("mercadolibre_order_id_required");
    return await request("/orders/" + id);
  }

  async function getShipment(shipmentId) {
    const id = encodeURIComponent(String(shipmentId || "").trim());
    if (!id) throw new Error("mercadolibre_shipment_id_required");
    return await request("/shipments/" + id, { headers: { "x-format-new": "true" } });
  }

  async function listQuestions(args = {}) {
    const id = await sellerId();
    return await request("/questions/search", {
      query: cleanObject({
        seller_id: id,
        api_version: 4,
        status: args.status,
        item_id: args.itemId,
        sort_fields: args.sortFields,
        sort_types: args.sortTypes,
        limit: safeInt(args.limit, 50, 1, 100),
        offset: safeInt(args.offset, 0, 0, 100000)
      })
    });
  }

  async function answerQuestion(questionId, text) {
    if (!allowWrite) throw new Error("mercadolibre_write_disabled");
    const id = Number(questionId);
    const answer = String(text || "").trim();
    if (!Number.isFinite(id)) throw new Error("mercadolibre_question_id_required");
    if (!answer) throw new Error("mercadolibre_answer_text_required");
    return await request("/answers", { method: "POST", body: { question_id: id, text: answer } });
  }

  async function getMessages(packId, args = {}) {
    const sid = await sellerId();
    const pid = encodeURIComponent(String(packId || "").trim());
    if (!pid) throw new Error("mercadolibre_pack_id_required");
    return await request("/messages/packs/" + pid + "/sellers/" + sid, {
      query: cleanObject({
        tag: args.tag || "post_sale",
        limit: safeInt(args.limit, 50, 1, 100),
        offset: safeInt(args.offset, 0, 0, 100000)
      })
    });
  }

  async function sendMessage(packId, buyerId, text, attachments = []) {
    if (!allowWrite) throw new Error("mercadolibre_write_disabled");
    const sid = await sellerId();
    const pid = encodeURIComponent(String(packId || "").trim());
    const bid = String(buyerId || "").trim();
    const message = String(text || "").trim();
    if (!pid) throw new Error("mercadolibre_pack_id_required");
    if (!bid) throw new Error("mercadolibre_buyer_id_required");
    if (!message) throw new Error("mercadolibre_message_text_required");
    return await request("/messages/packs/" + pid + "/sellers/" + sid, {
      method: "POST",
      query: { tag: "post_sale" },
      body: {
        from: { user_id: String(sid) },
        to: { user_id: String(bid) },
        text: message,
        attachments: Array.isArray(attachments) ? attachments.map(String) : []
      }
    });
  }

  async function listClaims(args = {}) {
    return await request("/post-purchase/v1/claims/search", {
      query: cleanObject({
        stage: args.stage,
        status: args.status,
        resource: args.resource,
        resource_id: args.resourceId,
        type: args.type,
        limit: safeInt(args.limit, 30, 1, 100),
        offset: safeInt(args.offset, 0, 0, 100000)
      })
    });
  }

  async function getClaim(claimId, { detail = true, messages = false, expectedResolutions = false, evidences = false, changes = false } = {}) {
    const id = encodeURIComponent(String(claimId || "").trim());
    if (!id) throw new Error("mercadolibre_claim_id_required");
    const base = "/post-purchase/v1/claims/" + id;
    const result = { claim: await request(base) };
    const reads = [];
    const keys = [];
    if (detail) { keys.push("detail"); reads.push(request(base + "/detail")); }
    if (messages) { keys.push("messages"); reads.push(request(base + "/messages")); }
    if (expectedResolutions) { keys.push("expectedResolutions"); reads.push(request(base + "/expected-resolutions")); }
    if (evidences) { keys.push("evidences"); reads.push(request(base + "/evidences")); }
    if (changes) { keys.push("changes"); reads.push(request(base + "/changes")); }
    const values = await Promise.all(reads.map((promise) => promise.catch((error) => ({ error: error.message, status: error.status || null }))));
    keys.forEach((key, index) => { result[key] = values[index]; });
    return result;
  }

  async function rawRead(path, query = {}, headers = {}) {
    return await request(path, { method: "GET", query, headers });
  }

  async function rawAction(method, path, query = {}, body, headers = {}) {
    if (!allowWrite) throw new Error("mercadolibre_write_disabled");
    const m = String(method || "").toUpperCase();
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(m)) throw new Error("mercadolibre_invalid_method");
    return await request(path, { method: m, query, body, headers });
  }

  return {
    oauthStatus,
    beginLogin,
    completeLogin,
    refresh,
    logout,
    sellerProfile,
    listItems,
    getItem,
    updateItem,
    listOrders,
    getOrder,
    getShipment,
    listQuestions,
    answerQuestion,
    getMessages,
    sendMessage,
    listClaims,
    getClaim,
    rawRead,
    rawAction,
    get allowWrite() { return allowWrite; }
  };
}
