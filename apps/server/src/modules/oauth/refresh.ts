import { db } from "../../database/client.js";
import type { SolPluginRuntimePrincipal } from "../plugins/types.js";
import { resolvePluginCredential, updatePluginCredential } from "../credentials/service.js";
import type { OAuthClientAuth } from "./service.js";

interface ProviderRow {
  provider: string;
  token_url: string;
  client_id: string;
  client_auth: OAuthClientAuth;
  client_secret_credential_id: string | null;
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

async function providerFor(
  principal: SolPluginRuntimePrincipal,
  provider: string,
): Promise<ProviderRow> {
  const result = await db.query<ProviderRow>(
    `SELECT provider, token_url, client_id, client_auth, client_secret_credential_id
     FROM oauth_provider_configs
     WHERE household_id=$1 AND owner_member_id=$2 AND plugin_id=$3 AND provider=$4`,
    [principal.householdId, principal.memberId, principal.pluginId, provider],
  );
  const row = result.rows[0];
  if (!row) throw new Error("oauth_provider_not_found");
  return row;
}

async function clientSecret(
  principal: SolPluginRuntimePrincipal,
  provider: ProviderRow,
): Promise<string | undefined> {
  if (!provider.client_secret_credential_id) return undefined;
  const resolved = await resolvePluginCredential(principal, provider.client_secret_credential_id);
  const value = resolved.secret.clientSecret;
  if (typeof value !== "string" || !value) throw new Error("oauth_client_secret_payload_invalid");
  return value;
}

export async function refreshOAuthCredential(
  principal: SolPluginRuntimePrincipal,
  credentialId: string,
): Promise<{ credentialId: string; provider: string; expiresAt?: string }> {
  const resolved = await resolvePluginCredential(principal, credentialId);
  if (resolved.credential.kind !== "oauth-token") throw new Error("credential_not_oauth_token");
  const refreshToken = resolved.secret.refresh_token;
  if (typeof refreshToken !== "string" || !refreshToken) throw new Error("oauth_refresh_token_missing");

  const provider = await providerFor(principal, resolved.credential.provider);
  const secret = await clientSecret(principal, provider);
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: provider.client_id,
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
  if (!response.ok) throw new Error(`oauth_refresh_failed:${response.status}`);
  const fresh = parseTokenBody(response.headers.get("content-type"), body);
  if (typeof fresh.access_token !== "string" || !fresh.access_token) throw new Error("oauth_access_token_missing");

  const merged: Record<string, unknown> = { ...resolved.secret, ...fresh };
  if (fresh.refresh_token === undefined) merged.refresh_token = refreshToken;
  const expiresIn = typeof fresh.expires_in === "number"
    ? fresh.expires_in
    : typeof fresh.expires_in === "string"
      ? Number(fresh.expires_in)
      : undefined;
  const expiresAt = expiresIn !== undefined && Number.isFinite(expiresIn)
    ? new Date(Date.now() + Math.max(0, expiresIn) * 1000).toISOString()
    : undefined;

  await updatePluginCredential(principal, credentialId, {
    secret: merged,
    metadata: resolved.credential.metadata,
    expiresAt,
  });

  await db.query(
    `UPDATE connections SET status='connected', last_error=NULL, updated_at=now()
     WHERE household_id=$1 AND owner_member_id=$2 AND plugin_id=$3 AND credential_id=$4`,
    [principal.householdId, principal.memberId, principal.pluginId, credentialId],
  );

  return { credentialId, provider: resolved.credential.provider, expiresAt };
}
