import { randomUUID } from "node:crypto";
import { db } from "../../database/client.js";
import type { SolPluginRuntimePrincipal } from "../plugins/types.js";
import { decryptSecretJson, encryptSecretJson, loadVaultMasterKey } from "./vault.js";

export interface CredentialRecord {
  id: string;
  householdId: string;
  ownerMemberId: string;
  pluginId: string;
  provider: string;
  kind: string;
  label: string;
  metadata: Record<string, unknown>;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface CredentialRow {
  id: string;
  household_id: string;
  owner_member_id: string;
  plugin_id: string;
  provider: string;
  kind: string;
  label: string;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_version: number;
  metadata: Record<string, unknown>;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const TOKEN_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${name}_must_be_text`);
  const result = value.trim();
  if (!result || result.length > max) throw new Error(`${name}_invalid`);
  return result;
}

function token(value: unknown, name: string): string {
  const result = text(value, name, 64).toLowerCase();
  if (!TOKEN_RE.test(result)) throw new Error(`${name}_invalid`);
  return result;
}

function metadata(value: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  if (value === undefined) return { ...fallback };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("credential_metadata_invalid");
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > 16 * 1024) throw new Error("credential_metadata_too_large");
  return JSON.parse(serialized) as Record<string, unknown>;
}

function secret(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("credential_secret_invalid");
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) throw new Error("credential_secret_too_large");
  return JSON.parse(serialized) as Record<string, unknown>;
}

function expiry(value: unknown): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("credential_expires_at_invalid");
  const result = new Date(value);
  if (Number.isNaN(result.valueOf())) throw new Error("credential_expires_at_invalid");
  return result;
}

function aad(row: Pick<CredentialRow, "id" | "household_id" | "owner_member_id" | "plugin_id">): string {
  return `sol.credentials.v1:${row.household_id}:${row.owner_member_id}:${row.plugin_id}:${row.id}`;
}

function record(row: CredentialRow): CredentialRecord {
  return {
    id: row.id,
    householdId: row.household_id,
    ownerMemberId: row.owner_member_id,
    pluginId: row.plugin_id,
    provider: row.provider,
    kind: row.kind,
    label: row.label,
    metadata: row.metadata ?? {},
    expiresAt: row.expires_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function scopedCredential(
  principal: SolPluginRuntimePrincipal,
  credentialId: string,
): Promise<CredentialRow> {
  const result = await db.query<CredentialRow>(
    `SELECT * FROM credentials
     WHERE id = $1 AND household_id = $2 AND owner_member_id = $3 AND plugin_id = $4`,
    [credentialId, principal.householdId, principal.memberId, principal.pluginId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("credential_not_found");
  return row;
}

export async function listPluginCredentials(
  principal: SolPluginRuntimePrincipal,
): Promise<CredentialRecord[]> {
  const result = await db.query<CredentialRow>(
    `SELECT * FROM credentials
     WHERE household_id = $1 AND owner_member_id = $2 AND plugin_id = $3
     ORDER BY updated_at DESC, id`,
    [principal.householdId, principal.memberId, principal.pluginId],
  );
  return result.rows.map(record);
}

export async function createPluginCredential(
  principal: SolPluginRuntimePrincipal,
  input: {
    provider?: unknown;
    kind?: unknown;
    label?: unknown;
    secret?: unknown;
    metadata?: unknown;
    expiresAt?: unknown;
  },
): Promise<CredentialRecord> {
  const id = randomUUID();
  const provider = token(input.provider, "credential_provider");
  const kind = input.kind === undefined ? "token" : token(input.kind, "credential_kind");
  const label = text(input.label, "credential_label", 200);
  const normalizedSecret = secret(input.secret);
  const normalizedMetadata = metadata(input.metadata);
  const expiresAt = expiry(input.expiresAt);
  const key = await loadVaultMasterKey();
  const encrypted = encryptSecretJson(key, normalizedSecret, `sol.credentials.v1:${principal.householdId}:${principal.memberId}:${principal.pluginId}:${id}`);

  const result = await db.query<CredentialRow>(
    `INSERT INTO credentials(
       id, household_id, owner_member_id, plugin_id, provider, kind, label,
       ciphertext, iv, auth_tag, key_version, metadata, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12)
     RETURNING *`,
    [
      id,
      principal.householdId,
      principal.memberId,
      principal.pluginId,
      provider,
      kind,
      label,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.authTag,
      normalizedMetadata,
      expiresAt,
    ],
  );
  return record(result.rows[0]!);
}

export async function resolvePluginCredential(
  principal: SolPluginRuntimePrincipal,
  credentialId: string,
): Promise<{ credential: CredentialRecord; secret: Record<string, unknown> }> {
  const row = await scopedCredential(principal, credentialId);
  if (row.key_version !== 1) throw new Error("credential_key_version_unsupported");
  const key = await loadVaultMasterKey();
  const decrypted = decryptSecretJson<Record<string, unknown>>(
    key,
    { ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag },
    aad(row),
  );
  return { credential: record(row), secret: decrypted };
}

export async function updatePluginCredential(
  principal: SolPluginRuntimePrincipal,
  credentialId: string,
  input: {
    label?: unknown;
    secret?: unknown;
    metadata?: unknown;
    expiresAt?: unknown;
  },
): Promise<CredentialRecord> {
  const current = await scopedCredential(principal, credentialId);
  const label = input.label === undefined ? current.label : text(input.label, "credential_label", 200);
  const normalizedMetadata = metadata(input.metadata, current.metadata ?? {});
  const expiresAt = input.expiresAt === undefined ? current.expires_at : expiry(input.expiresAt);

  let ciphertext = current.ciphertext;
  let iv = current.iv;
  let authTag = current.auth_tag;
  if (input.secret !== undefined) {
    const key = await loadVaultMasterKey();
    const encrypted = encryptSecretJson(key, secret(input.secret), aad(current));
    ciphertext = encrypted.ciphertext;
    iv = encrypted.iv;
    authTag = encrypted.authTag;
  }

  const result = await db.query<CredentialRow>(
    `UPDATE credentials SET
       label = $5,
       ciphertext = $6,
       iv = $7,
       auth_tag = $8,
       metadata = $9,
       expires_at = $10,
       updated_at = now()
     WHERE id = $1 AND household_id = $2 AND owner_member_id = $3 AND plugin_id = $4
     RETURNING *`,
    [
      credentialId,
      principal.householdId,
      principal.memberId,
      principal.pluginId,
      label,
      ciphertext,
      iv,
      authTag,
      normalizedMetadata,
      expiresAt,
    ],
  );
  return record(result.rows[0]!);
}

export async function deletePluginCredential(
  principal: SolPluginRuntimePrincipal,
  credentialId: string,
): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM credentials
     WHERE id = $1 AND household_id = $2 AND owner_member_id = $3 AND plugin_id = $4`,
    [credentialId, principal.householdId, principal.memberId, principal.pluginId],
  );
  if (!result.rowCount) throw new Error("credential_not_found");
  return true;
}

export async function assertPluginCredentialOwned(
  principal: SolPluginRuntimePrincipal,
  credentialId: string,
): Promise<void> {
  await scopedCredential(principal, credentialId);
}
