import { createHash, randomBytes } from "node:crypto";
import { config } from "../../../config.js";
import { db } from "../../../database/client.js";
import { openGoogleCredential, sealGoogleCredential } from "../google-calendar/crypto.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

interface StoredCredential {
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
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
  return `sol:gmail:${sourceAccountId}:oauth`;
}
function stateHash(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}
function challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
function requireConfig(): { clientId: string; clientSecret: string; redirectUri: string } {
  if (!config.gmailClientId || !config.gmailClientSecret) {
    throw new Error(
      "Gmail OAuth is not configured. Set SOL_GMAIL_CLIENT_ID/SOL_GMAIL_CLIENT_SECRET or reuse SOL_GOOGLE_CLIENT_ID/SOL_GOOGLE_CLIENT_SECRET.",
    );
  }
  return {
    clientId: config.gmailClientId,
    clientSecret: config.gmailClientSecret,
    redirectUri: config.gmailRedirectUri,
  };
}

async function tokenRequest(params: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: params,
  });
  const body = (await response.json()) as TokenResponse;
  if (!response.ok || body.error || !body.access_token) {
    throw new Error(
      body.error_description || body.error || `Gmail OAuth token exchange failed (${response.status})`,
    );
  }
  return body;
}

async function readCredential(sourceAccountId: string): Promise<StoredCredential | null> {
  const result = await db.query<{ encrypted_payload: string }>(
    "SELECT encrypted_payload FROM gmail_oauth_credentials WHERE source_account_id = $1",
    [sourceAccountId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const plaintext = await openGoogleCredential(row.encrypted_payload, credentialAad(sourceAccountId));
  return JSON.parse(plaintext) as StoredCredential;
}

async function saveCredential(
  sourceAccountId: string,
  credential: StoredCredential,
  scopes: string[] = [],
): Promise<void> {
  const encrypted = await sealGoogleCredential(JSON.stringify(credential), credentialAad(sourceAccountId));
  await db.query(
    `INSERT INTO gmail_oauth_credentials(
       source_account_id, encrypted_payload, granted_scopes, expires_at, last_refresh_at, last_error, updated_at
     ) VALUES ($1,$2,$3::text[],$4,now(),NULL,now())
     ON CONFLICT(source_account_id)
     DO UPDATE SET encrypted_payload = EXCLUDED.encrypted_payload,
                   granted_scopes = CASE WHEN cardinality(EXCLUDED.granted_scopes) > 0 THEN EXCLUDED.granted_scopes ELSE gmail_oauth_credentials.granted_scopes END,
                   expires_at = EXCLUDED.expires_at,
                   last_refresh_at = now(),
                   last_error = NULL,
                   updated_at = now()`,
    [sourceAccountId, encrypted, scopes, credential.expiresAt ? new Date(credential.expiresAt) : null],
  );
}

export function gmailConfigured(): boolean {
  return Boolean(config.gmailClientId && config.gmailClientSecret && config.gmailRedirectUri);
}

export async function startGmailOAuth(input: {
  householdId: string;
  memberId: string;
  sourceAccountId: string;
  redirectAfter?: string;
}): Promise<{ authorizationUrl: string; expiresAt: string }> {
  const { clientId, redirectUri } = requireConfig();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  await db.query("DELETE FROM gmail_oauth_states WHERE expires_at <= now() OR consumed_at IS NOT NULL");
  await db.query(
    `INSERT INTO gmail_oauth_states(
       household_id, member_id, source_account_id, state_hash, code_verifier, redirect_after, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.householdId,
      input.memberId,
      input.sourceAccountId,
      stateHash(state),
      verifier,
      input.redirectAfter ?? "/inputs",
      expiresAt,
    ],
  );

  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return { authorizationUrl: url.toString(), expiresAt: expiresAt.toISOString() };
}

export async function completeGmailOAuth(
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
       FROM gmail_oauth_states
       WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()
       FOR UPDATE`,
      [stateHash(state)],
    );
    row = result.rows[0];
    if (!row) throw new Error("Gmail OAuth state is invalid or expired");
    await client.query("UPDATE gmail_oauth_states SET consumed_at = now() WHERE state_hash = $1", [stateHash(state)]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  if (!row) throw new Error("Gmail OAuth state is invalid or expired");

  const token = await tokenRequest(
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: row.code_verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  );
  const existing = await readCredential(row.source_account_id);
  const refreshToken = token.refresh_token || existing?.refreshToken;
  if (!refreshToken) {
    throw new Error("Google did not return a Gmail refresh token. Reconnect and grant offline access.");
  }
  await saveCredential(
    row.source_account_id,
    {
      refreshToken,
      accessToken: token.access_token,
      expiresAt: Date.now() + Math.max(60, token.expires_in ?? 3600) * 1000,
      tokenType: token.token_type,
      scope: token.scope,
    },
    token.scope?.split(/\s+/).filter(Boolean) ?? SCOPES,
  );
  return {
    sourceAccountId: row.source_account_id,
    householdId: row.household_id,
    memberId: row.member_id,
    redirectAfter: row.redirect_after || "/inputs",
  };
}

export async function getGmailAccessToken(sourceAccountId: string, forceRefresh = false): Promise<string> {
  const { clientId, clientSecret } = requireConfig();
  const credential = await readCredential(sourceAccountId);
  if (!credential) throw new Error("Gmail account is not authenticated");
  if (
    !forceRefresh &&
    credential.accessToken &&
    credential.expiresAt &&
    credential.expiresAt > Date.now() + 60_000
  ) {
    return credential.accessToken;
  }
  try {
    const token = await tokenRequest(
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: credential.refreshToken,
        grant_type: "refresh_token",
      }),
    );
    const updated: StoredCredential = {
      ...credential,
      accessToken: token.access_token,
      expiresAt: Date.now() + Math.max(60, token.expires_in ?? 3600) * 1000,
      tokenType: token.token_type ?? credential.tokenType,
      scope: token.scope ?? credential.scope,
    };
    await saveCredential(sourceAccountId, updated, token.scope?.split(/\s+/).filter(Boolean));
    return updated.accessToken!;
  } catch (error) {
    await db.query(
      `UPDATE gmail_oauth_credentials SET last_error = $2, updated_at = now() WHERE source_account_id = $1`,
      [sourceAccountId, error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000)],
    ).catch(() => undefined);
    throw error;
  }
}

export async function clearGmailOAuth(sourceAccountId: string): Promise<void> {
  await db.query("DELETE FROM gmail_oauth_credentials WHERE source_account_id = $1", [sourceAccountId]);
}
