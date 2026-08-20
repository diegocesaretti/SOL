import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { config } from "../../../config.js";
import { db } from "../../../database/client.js";
import { openMercadoLibreCredential, sealMercadoLibreCredential } from "./crypto.js";
import { parseMercadoLibreJson } from "./json.js";

const TOKEN_URL = "https://api.mercadolibre.com/oauth/token";

interface StoredCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType?: string;
  scope?: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  user_id?: string | number;
  error?: string;
  message?: string;
  error_description?: string;
}

interface OAuthStateRow {
  source_account_id: string;
  household_id: string;
  member_id: string;
  code_verifier: string;
  redirect_after: string | null;
}

function credentialAad(sourceAccountId: string): string {
  return `sol:mercadolibre:${sourceAccountId}:oauth`;
}
function stateHash(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}
function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function requireConfig(): { clientId: string; clientSecret: string; redirectUri: string; authUrl: string } {
  if (!config.mercadoLibreClientId || !config.mercadoLibreClientSecret || !config.mercadoLibreRedirectUri) {
    throw new Error(
      "Mercado Libre OAuth is not configured. Set SOL_MERCADOLIBRE_CLIENT_ID, SOL_MERCADOLIBRE_CLIENT_SECRET and an HTTPS SOL_MERCADOLIBRE_REDIRECT_URI.",
    );
  }
  if (!config.mercadoLibreRedirectUri.startsWith("https://")) {
    throw new Error("Mercado Libre requires an HTTPS redirect URI registered exactly in the application settings");
  }
  return {
    clientId: config.mercadoLibreClientId,
    clientSecret: config.mercadoLibreClientSecret,
    redirectUri: config.mercadoLibreRedirectUri,
    authUrl: config.mercadoLibreAuthUrl,
  };
}

export function mercadoLibreConfigured(): boolean {
  return Boolean(
    config.mercadoLibreClientId &&
      config.mercadoLibreClientSecret &&
      config.mercadoLibreRedirectUri?.startsWith("https://"),
  );
}

async function tokenRequest(params: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  const text = await response.text();
  let body: TokenResponse = {};
  try {
    body = text ? parseMercadoLibreJson<TokenResponse>(text) : {};
  } catch {
    throw new Error(`Mercado Libre OAuth returned invalid JSON (${response.status})`);
  }
  if (!response.ok || body.error || !body.access_token) {
    throw new Error(
      body.error_description || body.message || body.error || `Mercado Libre OAuth token exchange failed (${response.status})`,
    );
  }
  return body;
}

async function encodeCredential(sourceAccountId: string, credential: StoredCredential): Promise<string> {
  return sealMercadoLibreCredential(JSON.stringify(credential), credentialAad(sourceAccountId));
}

async function decodeCredential(sourceAccountId: string, encrypted: string): Promise<StoredCredential> {
  const plaintext = await openMercadoLibreCredential(encrypted, credentialAad(sourceAccountId));
  return JSON.parse(plaintext) as StoredCredential;
}

async function saveCredentialWithClient(
  client: PoolClient,
  sourceAccountId: string,
  credential: StoredCredential,
): Promise<void> {
  const encrypted = await encodeCredential(sourceAccountId, credential);
  await client.query(
    `INSERT INTO mercadolibre_oauth_credentials(
       source_account_id, encrypted_payload, granted_scope, expires_at, last_refresh_at, last_error, updated_at
     ) VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), now(), NULL, now())
     ON CONFLICT(source_account_id)
     DO UPDATE SET encrypted_payload = EXCLUDED.encrypted_payload,
                   granted_scope = EXCLUDED.granted_scope,
                   expires_at = EXCLUDED.expires_at,
                   last_refresh_at = EXCLUDED.last_refresh_at,
                   last_error = NULL,
                   updated_at = now()`,
    [sourceAccountId, encrypted, credential.scope ?? null, credential.expiresAt],
  );
}

export async function startMercadoLibreOAuth(input: {
  householdId: string;
  memberId: string;
  sourceAccountId: string;
  redirectAfter?: string;
}): Promise<{ authorizationUrl: string; expiresAt: string }> {
  const { clientId, redirectUri, authUrl } = requireConfig();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const expiresAt = new Date(Date.now() + 10 * 60_000);

  await db.query("DELETE FROM mercadolibre_oauth_states WHERE expires_at <= now() OR consumed_at IS NOT NULL");
  await db.query(
    `INSERT INTO mercadolibre_oauth_states(
       state_hash, household_id, member_id, source_account_id, code_verifier, redirect_after, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      stateHash(state),
      input.householdId,
      input.memberId,
      input.sourceAccountId,
      verifier,
      input.redirectAfter ?? "/mercadolibre",
      expiresAt,
    ],
  );

  const url = new URL(authUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return { authorizationUrl: url.toString(), expiresAt: expiresAt.toISOString() };
}

export async function completeMercadoLibreOAuth(
  state: string,
  code: string,
): Promise<{ sourceAccountId: string; householdId: string; memberId: string; redirectAfter: string }> {
  const { clientId, clientSecret, redirectUri } = requireConfig();
  const client = await db.connect();
  let row: OAuthStateRow | undefined;
  try {
    await client.query("BEGIN");
    const result = await client.query<OAuthStateRow>(
      `SELECT source_account_id, household_id, member_id, code_verifier, redirect_after
       FROM mercadolibre_oauth_states
       WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()
       FOR UPDATE`,
      [stateHash(state)],
    );
    row = result.rows[0];
    if (!row) throw new Error("Mercado Libre OAuth state is invalid or expired");
    await client.query(
      "UPDATE mercadolibre_oauth_states SET consumed_at = now() WHERE state_hash = $1",
      [stateHash(state)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  if (!row) throw new Error("Mercado Libre OAuth state is invalid or expired");

  const token = await tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: row.code_verifier,
    }),
  );
  if (!token.refresh_token) throw new Error("Mercado Libre did not return a refresh token");

  const credential: StoredCredential = {
    accessToken: token.access_token!,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + Math.max(60, token.expires_in ?? 21_600) * 1000,
    tokenType: token.token_type,
    scope: token.scope,
  };
  const saveClient = await db.connect();
  try {
    await saveClient.query("BEGIN");
    await saveCredentialWithClient(saveClient, row.source_account_id, credential);
    await saveClient.query("COMMIT");
  } catch (error) {
    await saveClient.query("ROLLBACK");
    throw error;
  } finally {
    saveClient.release();
  }

  return {
    sourceAccountId: row.source_account_id,
    householdId: row.household_id,
    memberId: row.member_id,
    redirectAfter: row.redirect_after || "/mercadolibre",
  };
}

export async function getMercadoLibreAccessToken(
  sourceAccountId: string,
  forceRefresh = false,
): Promise<string> {
  const { clientId, clientSecret } = requireConfig();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Mercado Libre refresh tokens are single-use. Serialize refreshes per account.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`sol:mercadolibre:${sourceAccountId}`]);
    const result = await client.query<{ encrypted_payload: string }>(
      `SELECT encrypted_payload
       FROM mercadolibre_oauth_credentials
       WHERE source_account_id = $1
       FOR UPDATE`,
      [sourceAccountId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Mercado Libre account is not authenticated");
    const credential = await decodeCredential(sourceAccountId, row.encrypted_payload);

    if (
      !forceRefresh &&
      credential.accessToken &&
      credential.expiresAt > Date.now() + 90_000
    ) {
      await client.query("COMMIT");
      return credential.accessToken;
    }

    const token = await tokenRequest(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: credential.refreshToken,
      }),
    );
    if (!token.refresh_token) throw new Error("Mercado Libre refresh did not rotate the refresh token");
    const updated: StoredCredential = {
      accessToken: token.access_token!,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + Math.max(60, token.expires_in ?? 21_600) * 1000,
      tokenType: token.token_type ?? credential.tokenType,
      scope: token.scope ?? credential.scope,
    };
    await saveCredentialWithClient(client, sourceAccountId, updated);
    await client.query("COMMIT");
    return updated.accessToken;
  } catch (error) {
    await client.query("ROLLBACK");
    await db.query(
      `UPDATE mercadolibre_oauth_credentials
       SET last_error = $2, updated_at = now()
       WHERE source_account_id = $1`,
      [sourceAccountId, error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000)],
    ).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function clearMercadoLibreOAuth(sourceAccountId: string): Promise<void> {
  await db.query("DELETE FROM mercadolibre_oauth_credentials WHERE source_account_id = $1", [sourceAccountId]);
}
