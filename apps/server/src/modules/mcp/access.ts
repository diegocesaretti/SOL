import { createHash, randomBytes } from "node:crypto";
import { db } from "../../database/client.js";
import type { AuthPrincipal } from "../auth/session.js";

export interface McpAccessTokenView {
  id: string;
  label: string;
  scopes: string[];
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface AuthenticatedMcpAccess {
  principal: AuthPrincipal;
  scopes: string[];
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function normalizeLabel(label: unknown): string {
  const value = typeof label === "string" ? label.trim() : "";
  if (!value || value.length > 120) throw new Error("label must be between 1 and 120 characters");
  return value;
}

export async function createMcpAccessToken(
  principal: AuthPrincipal,
  input: { label?: string; expiresInDays?: number; allowSubmit?: boolean } = {},
): Promise<{ token: string; access: McpAccessTokenView }> {
  if (principal.role === "guest") throw new Error("guests cannot create MCP access tokens");
  const label = normalizeLabel(input.label ?? "Codex · Nexo");
  const requestedDays = Number(input.expiresInDays ?? 90);
  const expiresInDays = Number.isFinite(requestedDays)
    ? Math.max(1, Math.min(365, Math.trunc(requestedDays)))
    : 90;
  const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000);
  const token = `nexo_mcp_${randomBytes(32).toString("base64url")}`;
  const scopes = input.allowSubmit === true ? ["read", "submit"] : ["read"];
  const result = await db.query<{
    id: string;
    label: string;
    scopes: string[];
    created_at: Date;
    expires_at: Date | null;
    last_used_at: Date | null;
    revoked_at: Date | null;
  }>(
    `INSERT INTO mcp_access_tokens(
       household_id, member_id, label, token_hash, scopes, expires_at
     ) VALUES ($1, $2, $3, $4, $5::text[], $6)
     RETURNING id, label, scopes, created_at, expires_at, last_used_at, revoked_at`,
    [principal.householdId, principal.memberId, label, hashToken(token), scopes, expiresAt],
  );
  const row = result.rows[0];
  if (!row) throw new Error("failed_to_create_mcp_token");
  return {
    token,
    access: {
      id: row.id,
      label: row.label,
      scopes: row.scopes,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at?.toISOString(),
      lastUsedAt: row.last_used_at?.toISOString(),
      revokedAt: row.revoked_at?.toISOString(),
    },
  };
}

export async function listMcpAccessTokens(principal: AuthPrincipal): Promise<McpAccessTokenView[]> {
  const result = await db.query<{
    id: string;
    label: string;
    scopes: string[];
    created_at: Date;
    expires_at: Date | null;
    last_used_at: Date | null;
    revoked_at: Date | null;
  }>(
    `SELECT id, label, scopes, created_at, expires_at, last_used_at, revoked_at
     FROM mcp_access_tokens
     WHERE household_id = $1 AND member_id = $2
     ORDER BY created_at DESC
     LIMIT 100`,
    [principal.householdId, principal.memberId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    label: row.label,
    scopes: row.scopes,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at?.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString(),
    revokedAt: row.revoked_at?.toISOString(),
  }));
}

export async function revokeMcpAccessToken(
  principal: AuthPrincipal,
  tokenId: string,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE mcp_access_tokens
     SET revoked_at = COALESCE(revoked_at, now()), updated_at = now()
     WHERE id = $1 AND household_id = $2 AND member_id = $3`,
    [tokenId, principal.householdId, principal.memberId],
  );
  return Boolean(result.rowCount);
}

export async function authenticateMcpAccess(token: string): Promise<AuthenticatedMcpAccess | null> {
  const value = token.trim();
  if (!(value.startsWith("nexo_mcp_") || value.startsWith("sol_mcp_")) || value.length < 30) return null;
  const result = await db.query<{
    token_id: string;
    household_id: string;
    member_id: string;
    display_name: string;
    login_name: string;
    role: AuthPrincipal["role"];
    scopes: string[];
  }>(
    `SELECT t.id AS token_id, t.household_id, m.id AS member_id,
            m.display_name, m.login_name, m.role::text AS role, t.scopes
     FROM mcp_access_tokens t
     JOIN members m ON m.id = t.member_id
     WHERE t.token_hash = $1
       AND t.revoked_at IS NULL
       AND (t.expires_at IS NULL OR t.expires_at > now())
       AND 'read' = ANY(t.scopes)
       AND m.status = 'active'
     LIMIT 1`,
    [hashToken(value)],
  );
  const row = result.rows[0];
  if (!row) return null;
  void db.query(
    `UPDATE mcp_access_tokens SET last_used_at = now(), updated_at = now()
     WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '10 minutes')`,
    [row.token_id],
  ).catch((error) => console.error("Failed to update MCP token last_used_at", error));
  return {
    principal: {
      householdId: row.household_id,
      memberId: row.member_id,
      displayName: row.display_name,
      loginName: row.login_name,
      role: row.role,
    },
    scopes: row.scopes,
  };
}

export async function authenticateMcpToken(token: string): Promise<AuthPrincipal | null> {
  return (await authenticateMcpAccess(token))?.principal ?? null;
}
