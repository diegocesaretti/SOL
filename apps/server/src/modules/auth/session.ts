import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { config } from "../../config.js";
import { db } from "../../database/client.js";
import { verifyPassword } from "./password.js";

export const SESSION_COOKIE = "sol_session";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DUMMY_PASSWORD_HASH = `scrypt$${Buffer.alloc(16, 1).toString("base64url")}$${Buffer.alloc(64, 2).toString("base64url")}`;

export interface AuthPrincipal {
  householdId: string;
  memberId: string;
  displayName: string;
  loginName: string;
  role: "owner" | "adult" | "member" | "child" | "guest";
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").flatMap((part) => {
      const separator = part.indexOf("=");
      if (separator < 1) return [];
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      return [[name, value]];
    }),
  );
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (config.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

export function clearedSessionCookie(): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
  ];
  if (config.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

export async function loginMember(
  householdId: string,
  loginName: string,
  password: string,
): Promise<{ principal: AuthPrincipal; token: string; maxAgeSeconds: number } | null> {
  const normalizedLogin = loginName.trim();
  if (!UUID_PATTERN.test(householdId) || !normalizedLogin || !password) return null;

  const result = await db.query<{
    member_id: string;
    household_id: string;
    display_name: string;
    login_name: string;
    role: AuthPrincipal["role"];
    password_hash: string;
  }>(
    `SELECT
       m.id AS member_id,
       m.household_id,
       m.display_name,
       m.login_name,
       m.role::text AS role,
       c.password_hash
     FROM members m
     JOIN member_credentials c ON c.member_id = m.id
     WHERE m.household_id = $1
       AND lower(m.login_name) = lower($2)
       AND m.status = 'active'
     LIMIT 1`,
    [householdId, normalizedLogin],
  );

  const row = result.rows[0];
  if (!row) {
    // Keep the expensive password check on failed usernames too, reducing timing leakage.
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    return null;
  }
  if (!(await verifyPassword(password, row.password_hash))) return null;

  const token = randomBytes(32).toString("base64url");
  const maxAgeSeconds = config.sessionDays * 24 * 60 * 60;
  const expiresAt = new Date(Date.now() + maxAgeSeconds * 1000);

  await db.query(
    `INSERT INTO member_sessions(
       household_id, member_id, token_hash, expires_at
     ) VALUES ($1, $2, $3, $4)`,
    [row.household_id, row.member_id, tokenHash(token), expiresAt],
  );

  return {
    principal: {
      householdId: row.household_id,
      memberId: row.member_id,
      displayName: row.display_name,
      loginName: row.login_name,
      role: row.role,
    },
    token,
    maxAgeSeconds,
  };
}

export async function authenticateRequest(
  request: IncomingMessage,
): Promise<AuthPrincipal | null> {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;

  const hash = tokenHash(token);
  const result = await db.query<{
    session_id: string;
    household_id: string;
    member_id: string;
    display_name: string;
    login_name: string;
    role: AuthPrincipal["role"];
  }>(
    `SELECT
       s.id AS session_id,
       s.household_id,
       m.id AS member_id,
       m.display_name,
       m.login_name,
       m.role::text AS role
     FROM member_sessions s
     JOIN members m ON m.id = s.member_id
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND m.status = 'active'
     LIMIT 1`,
    [hash],
  );

  const row = result.rows[0];
  if (!row) return null;

  void db.query(
    `UPDATE member_sessions
     SET last_seen_at = now()
     WHERE id = $1 AND last_seen_at < now() - interval '10 minutes'`,
    [row.session_id],
  ).catch((error) => console.error("Failed to update session last_seen_at", error));

  return {
    householdId: row.household_id,
    memberId: row.member_id,
    displayName: row.display_name,
    loginName: row.login_name,
    role: row.role,
  };
}

export async function revokeRequestSession(request: IncomingMessage): Promise<void> {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (!token) return;
  await db.query(
    "UPDATE member_sessions SET revoked_at = now() WHERE token_hash = $1",
    [tokenHash(token)],
  );
}
