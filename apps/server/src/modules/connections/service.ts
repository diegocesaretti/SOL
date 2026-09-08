import { db } from "../../database/client.js";
import type { SolPluginRuntimePrincipal } from "../plugins/types.js";

export type ConnectionStatus = "connected" | "disconnected" | "needs_auth" | "syncing" | "error";

export interface ConnectionRecord {
  id: string;
  householdId: string;
  ownerMemberId: string | null;
  pluginId: string;
  provider: string;
  externalAccountId: string;
  displayName: string;
  status: ConnectionStatus;
  scopes: string[];
  metadata: Record<string, unknown>;
  lastSyncAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

interface ConnectionRow {
  id: string;
  household_id: string;
  owner_member_id: string | null;
  plugin_id: string;
  provider: string;
  external_account_id: string;
  display_name: string;
  status: ConnectionStatus;
  scopes: string[];
  metadata: Record<string, unknown>;
  last_sync_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

const PROVIDER_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const STATUS = new Set<ConnectionStatus>(["connected", "disconnected", "needs_auth", "syncing", "error"]);

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${name}_must_be_text`);
  const result = value.trim();
  if (!result || result.length > max) throw new Error(`${name}_invalid`);
  return result;
}

function provider(value: unknown): string {
  const result = text(value, "provider", 64).toLowerCase();
  if (!PROVIDER_RE.test(result)) throw new Error("provider_invalid");
  return result;
}

function status(value: unknown, fallback: ConnectionStatus): ConnectionStatus {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !STATUS.has(value as ConnectionStatus)) throw new Error("connection_status_invalid");
  return value as ConnectionStatus;
}

function scopes(value: unknown, fallback: string[] = []): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length > 100) throw new Error("connection_scopes_invalid");
  const result = value.map((item) => text(item, "connection_scope", 200));
  return [...new Set(result)];
}

function metadata(value: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  if (value === undefined) return { ...fallback };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("connection_metadata_invalid");
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > 32 * 1024) throw new Error("connection_metadata_too_large");
  return JSON.parse(serialized) as Record<string, unknown>;
}

function optionalError(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return text(value, "last_error", 2000);
}

function optionalDate(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("last_sync_at_invalid");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error("last_sync_at_invalid");
  return parsed;
}

function record(row: ConnectionRow): ConnectionRecord {
  return {
    id: row.id,
    householdId: row.household_id,
    ownerMemberId: row.owner_member_id,
    pluginId: row.plugin_id,
    provider: row.provider,
    externalAccountId: row.external_account_id,
    displayName: row.display_name,
    status: row.status,
    scopes: row.scopes ?? [],
    metadata: row.metadata ?? {},
    lastSyncAt: row.last_sync_at?.toISOString(),
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listPluginConnections(principal: SolPluginRuntimePrincipal): Promise<ConnectionRecord[]> {
  const result = await db.query<ConnectionRow>(
    `SELECT * FROM connections
     WHERE household_id = $1 AND owner_member_id = $2 AND plugin_id = $3
     ORDER BY updated_at DESC, id`,
    [principal.householdId, principal.memberId, principal.pluginId],
  );
  return result.rows.map(record);
}

export async function upsertPluginConnection(
  principal: SolPluginRuntimePrincipal,
  input: {
    provider?: unknown;
    externalAccountId?: unknown;
    displayName?: unknown;
    status?: unknown;
    scopes?: unknown;
    metadata?: unknown;
    lastSyncAt?: unknown;
    lastError?: unknown;
  },
): Promise<ConnectionRecord> {
  const normalizedProvider = provider(input.provider);
  const externalAccountId = text(input.externalAccountId, "external_account_id", 300);
  const displayName = text(input.displayName, "display_name", 200);
  const normalizedStatus = status(input.status, "disconnected");
  const normalizedScopes = scopes(input.scopes);
  const normalizedMetadata = metadata(input.metadata);
  const lastSyncAt = optionalDate(input.lastSyncAt) ?? null;
  const lastError = optionalError(input.lastError) ?? null;

  const result = await db.query<ConnectionRow>(
    `INSERT INTO connections(
       household_id, owner_member_id, plugin_id, provider, external_account_id,
       display_name, status, scopes, metadata, last_sync_at, last_error
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (household_id, owner_member_id, plugin_id, provider, external_account_id)
       WHERE owner_member_id IS NOT NULL
     DO UPDATE SET
       display_name = EXCLUDED.display_name,
       status = EXCLUDED.status,
       scopes = EXCLUDED.scopes,
       metadata = EXCLUDED.metadata,
       last_sync_at = EXCLUDED.last_sync_at,
       last_error = EXCLUDED.last_error,
       updated_at = now()
     RETURNING *`,
    [
      principal.householdId,
      principal.memberId,
      principal.pluginId,
      normalizedProvider,
      externalAccountId,
      displayName,
      normalizedStatus,
      normalizedScopes,
      normalizedMetadata,
      lastSyncAt,
      lastError,
    ],
  );
  return record(result.rows[0]!);
}

export async function updatePluginConnection(
  principal: SolPluginRuntimePrincipal,
  connectionId: string,
  input: {
    displayName?: unknown;
    status?: unknown;
    scopes?: unknown;
    metadata?: unknown;
    lastSyncAt?: unknown;
    lastError?: unknown;
  },
): Promise<ConnectionRecord> {
  const currentResult = await db.query<ConnectionRow>(
    `SELECT * FROM connections
     WHERE id = $1 AND household_id = $2 AND owner_member_id = $3 AND plugin_id = $4`,
    [connectionId, principal.householdId, principal.memberId, principal.pluginId],
  );
  const current = currentResult.rows[0];
  if (!current) throw new Error("connection_not_found");

  const displayName = input.displayName === undefined ? current.display_name : text(input.displayName, "display_name", 200);
  const normalizedStatus = status(input.status, current.status);
  const normalizedScopes = scopes(input.scopes, current.scopes ?? []);
  const normalizedMetadata = metadata(input.metadata, current.metadata ?? {});
  const lastSyncAt = optionalDate(input.lastSyncAt);
  const lastError = optionalError(input.lastError);

  const result = await db.query<ConnectionRow>(
    `UPDATE connections SET
       display_name = $5,
       status = $6,
       scopes = $7,
       metadata = $8,
       last_sync_at = $9,
       last_error = $10,
       updated_at = now()
     WHERE id = $1 AND household_id = $2 AND owner_member_id = $3 AND plugin_id = $4
     RETURNING *`,
    [
      connectionId,
      principal.householdId,
      principal.memberId,
      principal.pluginId,
      displayName,
      normalizedStatus,
      normalizedScopes,
      normalizedMetadata,
      lastSyncAt === undefined ? current.last_sync_at : lastSyncAt,
      lastError === undefined ? current.last_error : lastError,
    ],
  );
  return record(result.rows[0]!);
}

export async function deletePluginConnection(
  principal: SolPluginRuntimePrincipal,
  connectionId: string,
): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM connections
     WHERE id = $1 AND household_id = $2 AND owner_member_id = $3 AND plugin_id = $4`,
    [connectionId, principal.householdId, principal.memberId, principal.pluginId],
  );
  if (!result.rowCount) throw new Error("connection_not_found");
  return true;
}
