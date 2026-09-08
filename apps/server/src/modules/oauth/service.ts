import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db } from "../../database/client.js";
import type { SolPluginRuntimePrincipal } from "../plugins/types.js";
import {
  assertPluginCredentialOwned,
  createPluginCredential,
  deletePluginCredential,
  resolvePluginCredential,
} from "../credentials/service.js";

export type OAuthClientAuth = "none" | "body" | "basic";
export type OAuthFlowStatus = "pending" | "processing" | "completed" | "error" | "expired";

interface ProviderRow {
  id: string;
  household_id: string;
  owner_member_id: string;
  plugin_id: string;
  provider: string;
  authorization_url: string;
  token_url: string;
  redirect_uri: string;
  client_id: string;
  client_auth: OAuthClientAuth;
  client_secret_credential_id: string | null;
  default_scopes: string[];
  created_at: Date;
  updated_at: Date;
}

interface FlowRow {
  id: string;
  state_hash: string;
  household_id: string;
  owner_member_id: string;
  plugin_id: string;
  provider: string;
  connection_id: string | null;
  code_verifier: string;
  scopes: string[];
  redirect_uri: string;
  status: OAuthFlowStatus;
  credential_id: string | null;
  last_error: string | null;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const TOKEN_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${name}_must_be_text`);
  const result = value.trim();
  if (!result || result.length > max) throw new Error(`${name}_invalid`);
  return result;
}

function providerToken(value: unknown): string {
  const result = text(value, "oauth_provider", 64).toLowerCase();
  if (!TOKEN_RE.test(result)) throw new Error("oauth_provider_invalid");
  return result;
}

function safeOAuthUrl(value: unknown, name: string, allowLoopbackHttp = false): string {
  const raw = text(value, name, 2048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name}_invalid`);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(allowLoopbackHttp && url.protocol === "http:" && loopback)) {
    throw new Error(`${name}_must_use_https_or_loopback_http`);
  }
  if (url.username || url.password) throw new Error(`${name}_userinfo_not_allowed`);
  return url.toString();
}

function authMode(value: unknown): OAuthClientAuth {
  const mode = value === undefined ? "none" : value;
  if (mode !== "none" && mode !== "body" && mode !== "basic") throw new Error("oauth_client_auth_invalid");
  return mode;
}

function scopes(value: unknown, fallback: string[] = []): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length > 100) throw new Error("oauth_scopes_invalid");
  const result = value.map((item) => text(item, "oauth_scope", 300));
  return [...new Set(result)];
}

export function hashOAuthState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("base64url");
}

export function oauthPkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function runtimePrincipal(row: FlowRow): SolPluginRuntimePrincipal {
  return {
    householdId: row.household_id,
    memberId: row.owner_member_id,
    pluginId: row.plugin_id,
    permissions: [],
  };
}

async function providerFor(
  principal: SolPluginRuntimePrincipal,
  provider: string,
): Promise<ProviderRow> {
  const result = await db.query<ProviderRow>(
    `SELECT * FROM oauth_provider_configs
     WHERE household_id = $1 AND owner_member_id = $2 AND plugin_id = $3 AND provider = $4`,
    [principal.householdId, principal.memberId, principal.pluginId, provider],
  );
  const row = result.rows[0];
  if (!row) throw new Error("oauth_provider_not_found");
  return row;
}

export async function upsertOAuthProvider(
  principal: SolPluginRuntimePrincipal,
  input: {
    provider?: unknown;
    authorizationUrl?: unknown;
    tokenUrl?: unknown;
    redirectUri?: unknown;
    clientId?: unknown;
    clientAuth?: unknown;
    clientSecretCredentialId?: unknown;
    defaultScopes?: unknown;
  },
): Promise<Omit<ProviderRow, "client_secret_credential_id"> & { clientSecretCredentialId?: string }> {
  const provider = providerToken(input.provider);
  const authorizationUrl = safeOAuthUrl(input.authorizationUrl, "oauth_authorization_url", true);
  const tokenUrl = safeOAuthUrl(input.tokenUrl, "oauth_token_url", true);
  const redirectUri = safeOAuthUrl(input.redirectUri, "oauth_redirect_uri", true);
  const clientId = text(input.clientId, "oauth_client_id", 500);
  const clientAuth = authMode(input.clientAuth);
  const defaultScopes = scopes(input.defaultScopes);
  let clientSecretCredentialId: string | null = null;
  if (input.clientSecretCredentialId !== undefined && input.clientSecretCredentialId !== null && input.clientSecretCredentialId !== "") {
    if (typeof input.clientSecretCredentialId !== "string" || !UUID_RE.test(input.clientSecretCredentialId)) {
      throw new Error("oauth_client_secret_credential_id_invalid");
    }
    await assertPluginCredentialOwned(principal, input.clientSecretCredentialId);
    clientSecretCredentialId = input.clientSecretCredentialId;
  }
  if (clientAuth !== "none" && !clientSecretCredentialId) throw new Error("oauth_client_secret_required");

  const result = await db.query<ProviderRow>(
    `INSERT INTO oauth_provider_configs(
       household_id, owner_member_id, plugin_id, provider, authorization_url,
       token_url, redirect_uri, client_id, client_auth, client_secret_credential_id, default_scopes
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (household_id, owner_member_id, plugin_id, provider)
     DO UPDATE SET
       authorization_url = EXCLUDED.authorization_url,
       token_url = EXCLUDED.token_url,
       redirect_uri = EXCLUDED.redirect_uri,
       client_id = EXCLUDED.client_id,
       client_auth = EXCLUDED.client_auth,
       client_secret_credential_id = EXCLUDED.client_secret_credential_id,
       default_scopes = EXCLUDED.default_scopes,
       updated_at = now()
     RETURNING *`,
    [
      principal.householdId,
      principal.memberId,
      principal.pluginId,
      provider,
      authorizationUrl,
      tokenUrl,
      redirectUri,
      clientId,
      clientAuth,
      clientSecretCredentialId,
      defaultScopes,
    ],
  );
  const row = result.rows[0]!;
  return {
    ...row,
    clientSecretCredentialId: row.client_secret_credential_id ?? undefined,
  };
}

export async function listOAuthProviders(principal: SolPluginRuntimePrincipal): Promise<Array<{
  provider: string;
  authorizationUrl: string;
  tokenUrl: string;
  redirectUri: string;
  clientId: string;
  clientAuth: OAuthClientAuth;
  clientSecretCredentialId?: string;
  defaultScopes: string[];
}>> {
  const result = await db.query<ProviderRow>(
    `SELECT * FROM oauth_provider_configs
     WHERE household_id = $1 AND owner_member_id = $2 AND plugin_id = $3
     ORDER BY provider`,
    [principal.householdId, principal.memberId, principal.pluginId],
  );
  return result.rows.map((row) => ({
    provider: row.provider,
    authorizationUrl: row.authorization_url,
    tokenUrl: row.token_url,
    redirectUri: row.redirect_uri,
    clientId: row.client_id,
    clientAuth: row.client_auth,
    clientSecretCredentialId: row.client_secret_credential_id ?? undefined,
    defaultScopes: row.default_scopes ?? [],
  }));
}

async function assertConnectionOwned(principal: SolPluginRuntimePrincipal, connectionId: string): Promise<void> {
  const result = await db.query(
    `SELECT 1 FROM connections
     WHERE id = $1 AND household_id = $2 AND owner_member_id = $3 AND plugin_id = $4`,
    [connectionId, principal.householdId, principal.memberId, principal.pluginId],
  );
  if (!result.rowCount) throw new Error("connection_not_found");
}

export async function startOAuthFlow(
  principal: SolPluginRuntimePrincipal,
  input: { provider?: unknown; scopes?: unknown; connectionId?: unknown },
): Promise<{ flowId: string; authorizationUrl: string; expiresAt: string }> {
  const providerName = providerToken(input.provider);
  const provider = await providerFor(principal, providerName);
  const requestedScopes = scopes(input.scopes, provider.default_scopes ?? []);
  let connectionId: string | null = null;
  if (input.connectionId !== undefined && input.connectionId !== null && input.connectionId !== "") {
    if (typeof input.connectionId !== "string" || !UUID_RE.test(input.connectionId)) throw new Error("connection_id_invalid");
    await assertConnectionOwned(principal, input.connectionId);
    connectionId = input.connectionId;
  }

  const flowId = randomUUID();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await db.query(
    `INSERT INTO oauth_flows(
       id, state_hash, household_id, owner_member_id, plugin_id, provider,
       connection_id, code_verifier, scopes, redirect_uri, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      flowId,
      hashOAuthState(state),
      principal.householdId,
      principal.memberId,
      principal.pluginId,
      providerName,
      connectionId,
      verifier,
      requestedScopes,
      provider.redirect_uri,
      expiresAt,
    ],
  );

  const auth = new URL(provider.authorization_url);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("client_id", provider.client_id);
  auth.searchParams.set("redirect_uri", provider.redirect_uri);
  if (requestedScopes.length) auth.searchParams.set("scope", requestedScopes.join(" "));
  auth.searchParams.set("state", state);
  auth.searchParams.set("code_challenge", oauthPkceChallenge(verifier));
  auth.searchParams.set("code_challenge_method", "S256");

  return { flowId, authorizationUrl: auth.toString(), expiresAt: expiresAt.toISOString() };
}

export async function getOAuthFlow(
  principal: SolPluginRuntimePrincipal,
  flowId: string,
): Promise<{ id: string; provider: string; status: OAuthFlowStatus; credentialId?: string; lastError?: string; expiresAt: string }> {
  const result = await db.query<FlowRow>(
    `SELECT * FROM oauth_flows
     WHERE id = $1 AND household_id = $2 AND owner_member_id = $3 AND plugin_id = $4`,
    [flowId, principal.householdId, principal.memberId, principal.pluginId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("oauth_flow_not_found");
  const status: OAuthFlowStatus = row.status === "pending" && row.expires_at.getTime() < Date.now() ? "expired" : row.status;
  return {
    id: row.id,
    provider: row.provider,
    status,
    credentialId: row.credential_id ?? undefined,
    lastError: row.last_error ?? undefined,
    expiresAt: row.expires_at.toISOString(),
  };
}

async function providerForFlow(flow: FlowRow): Promise<ProviderRow> {
  const result = await db.query<ProviderRow>(
    `SELECT * FROM oauth_provider_configs
     WHERE household_id = $1 AND owner_member_id = $2 AND plugin_id = $3 AND provider = $4`,
    [flow.household_id, flow.owner_member_id, flow.plugin_id, flow.provider],
  );
  const row = result.rows[0];
  if (!row) throw new Error("oauth_provider_not_found");
  return row;
}

async function clientSecret(provider: ProviderRow, principal: SolPluginRuntimePrincipal): Promise<string | undefined> {
  if (!provider.client_secret_credential_id) return undefined;
  const resolved = await resolvePluginCredential(principal, provider.client_secret_credential_id);
  const value = resolved.secret.clientSecret;
  if (typeof value !== "string" || !value) throw new Error("oauth_client_secret_payload_invalid");
  return value;
}

function parseTokenBody(contentType: string | null, body: string): Record<string, unknown> {
  if (contentType?.includes("application/json")) {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("oauth_token_response_invalid");
    return parsed as Record<string, unknown>;
  }
  const params = new URLSearchParams(body);
  const result: Record<string, unknown> = {};
  for (const [key, value] of params) result[key] = value;
  return result;
}

async function exchangeCode(flow: FlowRow, provider: ProviderRow, code: string): Promise<Record<string, unknown>> {
  const principal = runtimePrincipal(flow);
  const secret = await clientSecret(provider, principal);
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: flow.redirect_uri,
    client_id: provider.client_id,
    code_verifier: flow.code_verifier,
  });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (provider.client_auth === "body" && secret) form.set("client_secret", secret);
  if (provider.client_auth === "basic" && secret) {
    headers.authorization = `Basic ${Buffer.from(`${provider.client_id}:${secret}`, "utf8").toString("base64")}`;
  }

  const response = await fetch(provider.token_url, {
    method: "POST",
    headers,
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`oauth_token_exchange_failed:${response.status}`);
  const token = parseTokenBody(response.headers.get("content-type"), body);
  if (typeof token.access_token !== "string" || !token.access_token) throw new Error("oauth_access_token_missing");
  return token;
}

async function finalizeOAuthSuccess(flow: FlowRow, credentialId: string): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (flow.connection_id) {
      const connection = await client.query(
        `UPDATE connections SET
           credential_id = $5,
           status = 'connected',
           scopes = $6,
           last_error = NULL,
           updated_at = now()
         WHERE id = $1 AND household_id = $2 AND owner_member_id = $3 AND plugin_id = $4`,
        [flow.connection_id, flow.household_id, flow.owner_member_id, flow.plugin_id, credentialId, flow.scopes],
      );
      if (!connection.rowCount) throw new Error("connection_not_found");
    }
    const completed = await client.query(
      `UPDATE oauth_flows SET
         status='completed', credential_id=$2, last_error=NULL,
         consumed_at=now(), updated_at=now()
       WHERE id=$1 AND status='processing'`,
      [flow.id, credentialId],
    );
    if (!completed.rowCount) throw new Error("oauth_flow_claim_lost");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function markFlowError(flowId: string, message: string): Promise<void> {
  await db.query(
    `UPDATE oauth_flows SET
       status='error', last_error=$2, consumed_at=now(), updated_at=now()
     WHERE id=$1 AND status='processing'`,
    [flowId, message.slice(0, 2000)],
  );
}

async function claimOAuthFlow(state: string): Promise<FlowRow | null> {
  const result = await db.query<FlowRow>(
    `UPDATE oauth_flows SET status='processing', updated_at=now()
     WHERE state_hash=$1 AND status='pending' AND expires_at >= now()
     RETURNING *`,
    [hashOAuthState(state)],
  );
  return result.rows[0] ?? null;
}

async function explainUnclaimedFlow(state: string): Promise<{ provider?: string; error: string }> {
  const result = await db.query<FlowRow>(
    `SELECT * FROM oauth_flows WHERE state_hash=$1`,
    [hashOAuthState(state)],
  );
  const flow = result.rows[0];
  if (!flow) return { error: "oauth_flow_not_found" };
  if (flow.status === "pending" && flow.expires_at.getTime() < Date.now()) {
    await db.query(
      `UPDATE oauth_flows SET status='expired', updated_at=now()
       WHERE id=$1 AND status='pending'`,
      [flow.id],
    );
    return { provider: flow.provider, error: "oauth_flow_expired" };
  }
  return { provider: flow.provider, error: "oauth_flow_already_consumed" };
}

export async function completeOAuthCallback(
  input: { state?: string | null; code?: string | null; error?: string | null; errorDescription?: string | null },
): Promise<{ ok: boolean; provider?: string; error?: string }> {
  const state = input.state?.trim();
  if (!state) return { ok: false, error: "oauth_state_missing" };

  const flow = await claimOAuthFlow(state);
  if (!flow) {
    return { ok: false, ...(await explainUnclaimedFlow(state)) };
  }

  if (input.error) {
    const detail = `${input.error}${input.errorDescription ? `: ${input.errorDescription}` : ""}`.slice(0, 2000);
    await markFlowError(flow.id, detail);
    return { ok: false, provider: flow.provider, error: detail };
  }
  const code = input.code?.trim();
  if (!code) {
    await markFlowError(flow.id, "oauth_code_missing");
    return { ok: false, provider: flow.provider, error: "oauth_code_missing" };
  }

  let credentialId: string | undefined;
  const principal = runtimePrincipal(flow);
  try {
    const provider = await providerForFlow(flow);
    const token = await exchangeCode(flow, provider, code);
    const expiresIn = typeof token.expires_in === "number"
      ? token.expires_in
      : typeof token.expires_in === "string"
        ? Number(token.expires_in)
        : undefined;
    const expiresAt = expiresIn !== undefined && Number.isFinite(expiresIn)
      ? new Date(Date.now() + Math.max(0, expiresIn) * 1000).toISOString()
      : undefined;
    const credential = await createPluginCredential(principal, {
      provider: flow.provider,
      kind: "oauth-token",
      label: `${flow.provider} OAuth`,
      secret: token,
      metadata: { scopes: flow.scopes, source: "oauth.v1" },
      expiresAt,
    });
    credentialId = credential.id;
    await finalizeOAuthSuccess(flow, credential.id);
    return { ok: true, provider: flow.provider };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    if (credentialId) {
      await deletePluginCredential(principal, credentialId).catch(() => undefined);
    }
    await markFlowError(flow.id, message);
    return { ok: false, provider: flow.provider, error: message };
  }
}
