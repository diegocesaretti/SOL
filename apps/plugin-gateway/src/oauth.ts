import { gatewayConfig } from "./config.js";
import {
  pkceS256,
  randomId,
  secureStringEqual,
  signOpaqueToken,
  verifyOpaqueToken,
  type SignedPayload,
} from "./crypto.js";
import { consumePairCode, type SolScope } from "./state.js";

interface ClientPayload extends SignedPayload {
  typ: "oauth_client";
  redirectUris: string[];
  clientName?: string;
}

interface AuthorizationCodePayload extends SignedPayload {
  typ: "authorization_code";
  jti: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  codeChallenge: string;
  instanceId: string;
}

interface AccessTokenPayload extends SignedPayload {
  typ: "access_token";
  sub: string;
  aud: string;
  clientId: string;
  instanceId: string;
  scopes: string[];
}

interface RefreshTokenPayload extends SignedPayload {
  typ: "refresh_token";
  sub: string;
  aud: string;
  clientId: string;
  instanceId: string;
  scopes: string[];
}

const authorizationCodes = new Map<string, AuthorizationCodePayload>();
const OAUTH_SCOPES = new Set(["sol.read", "sol.submit", "sol.actions"]);

function seconds(): number {
  return Math.floor(Date.now() / 1000);
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function html(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char] ?? char);
}

function formValue(form: URLSearchParams, name: string): string {
  return form.get(name)?.trim() ?? "";
}

function parseScopes(value: string | null): string[] {
  const values = (value ?? "sol.read sol.submit sol.actions").split(/\s+/).filter(Boolean);
  if (!values.length) values.push("sol.read");
  if (!values.includes("sol.read")) values.unshift("sol.read");
  if (values.some((scope) => !OAUTH_SCOPES.has(scope))) throw new Error("invalid_scope");
  return [...new Set(values)];
}

function solScopesFromOAuth(scopes: string[]): SolScope[] {
  const result: SolScope[] = ["read"];
  if (scopes.includes("sol.submit")) result.push("submit");
  if (scopes.includes("sol.actions")) result.push("actions");
  return result;
}

function ensureAllowedScopes(requested: string[], allowed: SolScope[]): void {
  const mapped = solScopesFromOAuth(requested);
  if (mapped.some((scope) => !allowed.includes(scope))) throw new Error("scope_not_allowed_by_sol_bridge");
}

function oauthError(code: string, description: string, status = 400): Response {
  return json({ error: code, error_description: description }, status);
}

function validateRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return false;
    return !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function validateClient(clientId: string): ClientPayload | null {
  if (!clientId.startsWith("sol_client_")) return null;
  return verifyOpaqueToken<ClientPayload>(clientId.slice("sol_client_".length), "oauth_client");
}

function redirectWithError(redirectUri: string, state: string, error: string, description: string): Response {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  url.searchParams.set("iss", gatewayConfig.publicOrigin);
  if (state) url.searchParams.set("state", state);
  return Response.redirect(url.toString(), 302);
}

function authorizeForm(params: URLSearchParams, error?: string): Response {
  const requested = parseScopes(params.get("scope"));
  const hidden = [
    "client_id",
    "redirect_uri",
    "response_type",
    "scope",
    "state",
    "code_challenge",
    "code_challenge_method",
    "resource",
  ].map((name) => `<input type="hidden" name="${name}" value="${escapeHtml(params.get(name) ?? "")}">`).join("");
  return html(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conectar SOL con ChatGPT</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#101214;color:#f5f5f5;margin:0;padding:28px}.card{max-width:540px;margin:8vh auto;background:#181b20;border:1px solid #30343a;border-radius:18px;padding:24px}h1{font-size:26px;margin:0 0 10px}p{line-height:1.45;color:#c9cdd3}label{display:block;margin:20px 0 7px;font-weight:650}input[type=text]{width:100%;box-sizing:border-box;padding:14px 16px;border-radius:12px;border:1px solid #454a52;background:#0d0f12;color:#fff;font-size:20px;letter-spacing:2px;text-transform:uppercase}button{margin-top:18px;width:100%;padding:14px;border:0;border-radius:12px;font-weight:700;font-size:16px;cursor:pointer}.scopes{font-size:14px;background:#0d0f12;border-radius:12px;padding:12px}.err{background:#4a1820;color:#ffd6da;padding:10px 12px;border-radius:10px}</style></head>
<body><div class="card"><h1>Conectar ChatGPT con SOL</h1>
<p>Abrí <strong>SOL → MCP → Plugin ChatGPT</strong> en tu PC y copiá el código temporal de emparejamiento. No ingreses tu contraseña de SOL acá.</p>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
<div class="scopes"><strong>Permisos solicitados</strong><br>${requested.map(escapeHtml).join("<br>")}</div>
<form method="post" action="/oauth/authorize">${hidden}
<label for="pair_code">Código de SOL</label><input id="pair_code" name="pair_code" type="text" autocomplete="one-time-code" placeholder="ABCD-EFGH" required>
<button type="submit">Conectar SOL</button></form>
<p style="font-size:13px">El código vence automáticamente y sólo vincula la instancia de SOL que lo generó.</p>
</div></body></html>`);
}

function resourceMatches(value: string): boolean {
  return value.replace(/\/$/, "") === gatewayConfig.publicOrigin;
}

export function oauthProtectedResourceMetadata(): Response {
  return json({
    resource: gatewayConfig.publicOrigin,
    authorization_servers: [gatewayConfig.publicOrigin],
    scopes_supported: [...OAUTH_SCOPES],
    resource_documentation: `${gatewayConfig.publicOrigin}/support`,
    resource_policy_uri: `${gatewayConfig.publicOrigin}/privacy`,
    resource_tos_uri: `${gatewayConfig.publicOrigin}/terms`,
  });
}

export function oauthAuthorizationServerMetadata(): Response {
  return json({
    issuer: gatewayConfig.publicOrigin,
    authorization_endpoint: `${gatewayConfig.publicOrigin}/oauth/authorize`,
    token_endpoint: `${gatewayConfig.publicOrigin}/oauth/token`,
    registration_endpoint: `${gatewayConfig.publicOrigin}/oauth/register`,
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
  });
}

export function oauthChallenge(requiredScopes: string[] = ["sol.read"]): string {
  const metadata = `${gatewayConfig.publicOrigin}/.well-known/oauth-protected-resource`;
  return `Bearer resource_metadata="${metadata}", scope="${requiredScopes.join(" ")}"`;
}

export function verifyAccessToken(authorization: string | null): AccessTokenPayload | null {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) return null;
  const payload = verifyOpaqueToken<AccessTokenPayload>(match[1], "access_token");
  if (!payload || !resourceMatches(payload.aud) || !payload.scopes.includes("sol.read")) return null;
  return payload;
}

async function registerClient(request: Request): Promise<Response> {
  let input: Record<string, unknown>;
  try {
    input = await request.json() as Record<string, unknown>;
  } catch {
    return oauthError("invalid_client_metadata", "Request body must be JSON");
  }
  const redirectUris = Array.isArray(input.redirect_uris)
    ? input.redirect_uris.filter((value): value is string => typeof value === "string" && validateRedirectUri(value))
    : [];
  if (!redirectUris.length) return oauthError("invalid_redirect_uri", "At least one valid redirect_uri is required");
  const payload: ClientPayload = {
    typ: "oauth_client",
    iat: seconds(),
    exp: seconds() + 90 * 24 * 60 * 60,
    redirectUris: [...new Set(redirectUris)],
    clientName: typeof input.client_name === "string" ? input.client_name.slice(0, 160) : undefined,
  };
  const clientId = `sol_client_${signOpaqueToken(payload)}`;
  return json({
    client_id: clientId,
    client_id_issued_at: payload.iat,
    redirect_uris: payload.redirectUris,
    client_name: payload.clientName,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }, 201);
}

function validateAuthorizeParams(params: URLSearchParams): { client: ClientPayload; scopes: string[] } | Response {
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const resource = params.get("resource") ?? gatewayConfig.publicOrigin;
  const client = validateClient(clientId);
  if (!client) return oauthError("invalid_client", "Unknown or expired OAuth client");
  if (!client.redirectUris.includes(redirectUri)) return oauthError("invalid_request", "redirect_uri does not match the registered client");
  if (params.get("response_type") !== "code") return oauthError("unsupported_response_type", "Only authorization_code is supported");
  if (!resourceMatches(resource)) return oauthError("invalid_target", "resource must identify this SOL MCP server");
  if (params.get("code_challenge_method") !== "S256" || !(params.get("code_challenge") ?? "")) {
    return oauthError("invalid_request", "PKCE S256 is required");
  }
  try {
    return { client, scopes: parseScopes(params.get("scope")) };
  } catch {
    return oauthError("invalid_scope", "Unsupported OAuth scope");
  }
}

async function authorizeGet(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const validation = validateAuthorizeParams(params);
  if (validation instanceof Response) return validation;
  return authorizeForm(params);
}

async function authorizePost(request: Request): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const validation = validateAuthorizeParams(form);
  const redirectUri = formValue(form, "redirect_uri");
  const state = formValue(form, "state");
  if (validation instanceof Response) {
    return validateRedirectUri(redirectUri)
      ? redirectWithError(redirectUri, state, "invalid_request", "OAuth request validation failed")
      : validation;
  }
  const submittedPairCode = formValue(form, "pair_code");
  console.log("SOL OAuth pairing attempt", {
    pairCodeLength: submittedPairCode.length,
    pairCodePrefix: submittedPairCode.slice(0, 5),
    pairCodeSuffix: submittedPairCode.slice(-4),
    clientIdPrefix: formValue(form, "client_id").slice(0, 12),
    redirectHost: (() => { try { return new URL(redirectUri).host; } catch { return "invalid"; } })(),
  });
  const pairing = consumePairCode(submittedPairCode);
  console.log("SOL OAuth pairing result", {
    accepted: Boolean(pairing),
    instanceIdSuffix: pairing?.instanceId.slice(-8) ?? null,
  });
  if (!pairing) return authorizeForm(form, "El código no existe o ya venció. Generá uno nuevo desde SOL.");
  try {
    ensureAllowedScopes(validation.scopes, pairing.allowedScopes);
  } catch {
    return authorizeForm(form, "SOL no autorizó todos los permisos solicitados para este código.");
  }
  const payload: AuthorizationCodePayload = {
    typ: "authorization_code",
    iat: seconds(),
    exp: seconds() + 180,
    jti: randomId(18),
    clientId: formValue(form, "client_id"),
    redirectUri,
    resource: formValue(form, "resource") || gatewayConfig.publicOrigin,
    scopes: validation.scopes,
    codeChallenge: formValue(form, "code_challenge"),
    instanceId: pairing.instanceId,
  };
  const url = new URL(redirectUri);
  const authorizationCode = `sol_ac_${randomId(24)}`;
  authorizationCodes.set(authorizationCode, payload);
  url.searchParams.set("code", authorizationCode);
  url.searchParams.set("iss", gatewayConfig.publicOrigin);
  if (state) url.searchParams.set("state", state);
  console.log("SOL OAuth authorize redirect", {
    redirectHost: url.host,
    redirectPath: url.pathname,
    codeLength: authorizationCode.length,
    locationLength: url.toString().length,
    hasState: Boolean(state),
  });
  return Response.redirect(url.toString(), 302);
}

function issueTokens(input: {
  clientId: string;
  instanceId: string;
  scopes: string[];
  resource: string;
  includeRefresh: boolean;
}): Response {
  const now = seconds();
  const access: AccessTokenPayload = {
    typ: "access_token",
    iat: now,
    exp: now + gatewayConfig.accessTokenTtlSeconds,
    sub: `sol-instance:${input.instanceId}`,
    aud: input.resource,
    clientId: input.clientId,
    instanceId: input.instanceId,
    scopes: input.scopes,
  };
  const output: Record<string, unknown> = {
    access_token: signOpaqueToken(access),
    token_type: "Bearer",
    expires_in: gatewayConfig.accessTokenTtlSeconds,
    scope: input.scopes.join(" "),
  };
  if (input.includeRefresh) {
    const refresh: RefreshTokenPayload = {
      typ: "refresh_token",
      iat: now,
      exp: now + gatewayConfig.refreshTokenTtlSeconds,
      sub: access.sub,
      aud: input.resource,
      clientId: input.clientId,
      instanceId: input.instanceId,
      scopes: input.scopes,
    };
    output.refresh_token = signOpaqueToken(refresh);
  }
  return json(output);
}

async function tokenEndpoint(request: Request): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const grantType = formValue(form, "grant_type");
  const clientId = formValue(form, "client_id");
  console.log("SOL OAuth token attempt", {
    grantType,
    hasClientId: Boolean(clientId),
    clientIdPrefix: clientId.slice(0, 12),
    hasCode: Boolean(formValue(form, "code")),
    hasVerifier: Boolean(formValue(form, "code_verifier")),
    hasRedirectUri: Boolean(formValue(form, "redirect_uri")),
    redirectHost: (() => { try { return new URL(formValue(form, "redirect_uri")).host; } catch { return "missing_or_invalid"; } })(),
    hasResource: Boolean(formValue(form, "resource")),
  });
  const client = validateClient(clientId);
  if (!client) {
    console.log("SOL OAuth token result", { ok: false, reason: "invalid_client" });
    return oauthError("invalid_client", "Unknown or expired OAuth client", 401);
  }

  if (grantType === "authorization_code") {
    const authorizationCode = formValue(form, "code");
    const code = authorizationCodes.get(authorizationCode);
    if (!code || (code.exp ?? 0) <= seconds()) {
      if (authorizationCode) authorizationCodes.delete(authorizationCode);
      console.log("SOL OAuth token result", { ok: false, reason: "invalid_or_expired_code" });
      return oauthError("invalid_grant", "Authorization code is invalid or expired");
    }
    if (code.clientId !== clientId || code.redirectUri !== formValue(form, "redirect_uri")) {
      console.log("SOL OAuth token result", { ok: false, reason: "client_or_redirect_mismatch" });
      return oauthError("invalid_grant", "Authorization code client or redirect_uri mismatch");
    }
    const resource = formValue(form, "resource") || code.resource;
    if (!resourceMatches(resource) || code.resource !== resource) {
      console.log("SOL OAuth token result", { ok: false, reason: "resource_mismatch", resource });
      return oauthError("invalid_target", "resource mismatch");
    }
    const verifier = formValue(form, "code_verifier");
    if (!verifier || !secureStringEqual(pkceS256(verifier), code.codeChallenge)) {
      console.log("SOL OAuth token result", { ok: false, reason: "pkce_failed" });
      return oauthError("invalid_grant", "PKCE verification failed");
    }
    authorizationCodes.delete(authorizationCode);
    console.log("SOL OAuth token result", { ok: true, grantType: "authorization_code", instanceIdSuffix: code.instanceId.slice(-8), scopes: code.scopes });
    return issueTokens({
      clientId,
      instanceId: code.instanceId,
      scopes: code.scopes,
      resource,
      includeRefresh: true,
    });
  }

  if (grantType === "refresh_token") {
    const refresh = verifyOpaqueToken<RefreshTokenPayload>(formValue(form, "refresh_token"), "refresh_token");
    if (!refresh || refresh.clientId !== clientId || !resourceMatches(refresh.aud)) {
      return oauthError("invalid_grant", "Refresh token is invalid or expired");
    }
    return issueTokens({
      clientId,
      instanceId: refresh.instanceId,
      scopes: refresh.scopes,
      resource: refresh.aud,
      includeRefresh: false,
    });
  }

  return oauthError("unsupported_grant_type", "Supported grants are authorization_code and refresh_token");
}

export async function handleOAuth(request: Request): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) {
    return oauthProtectedResourceMetadata();
  }
  if (request.method === "GET" && (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration")) {
    return oauthAuthorizationServerMetadata();
  }
  if (request.method === "POST" && path === "/oauth/register") return await registerClient(request);
  if (path === "/oauth/authorize" && request.method === "GET") return await authorizeGet(request);
  if (path === "/oauth/authorize" && request.method === "POST") return await authorizePost(request);
  if (request.method === "POST" && path === "/oauth/token") return await tokenEndpoint(request);
  return null;
}

export function cleanupOAuthState(): void {
  const now = seconds();
  for (const [authorizationCode, payload] of authorizationCodes) {
    if ((payload.exp ?? 0) <= now) authorizationCodes.delete(authorizationCode);
  }
}
