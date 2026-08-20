import { db } from "../../database/client.js";

export interface SourceAccountRecord {
  id: string;
  householdId: string;
  ownerMemberId?: string;
  provider: string;
  externalAccountId?: string;
  label: string;
  status: "connected" | "disconnected" | "error";
  authMode?: string;
  lastSyncAt?: string;
}

export interface CreateSourceAccountInput {
  householdId: string;
  ownerMemberId?: string;
  provider: string;
  label: string;
  authMode?: string;
}

export class SourceAccountValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceAccountValidationError";
  }
}

function normalizedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SourceAccountValidationError(`${label} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new SourceAccountValidationError(`${label} is too long`);
  }
  return normalized;
}

function rowToSource(row: {
  id: string;
  household_id: string;
  owner_member_id: string | null;
  provider: string;
  external_account_id: string | null;
  label: string;
  status: SourceAccountRecord["status"];
  auth_mode: string | null;
  last_sync_at: Date | null;
}): SourceAccountRecord {
  return {
    id: row.id,
    householdId: row.household_id,
    ownerMemberId: row.owner_member_id ?? undefined,
    provider: row.provider,
    externalAccountId: row.external_account_id ?? undefined,
    label: row.label,
    status: row.status,
    authMode: row.auth_mode ?? undefined,
    lastSyncAt: row.last_sync_at?.toISOString(),
  };
}

export async function getSourceAccount(sourceAccountId: string): Promise<SourceAccountRecord | null> {
  const result = await db.query<{
    id: string;
    household_id: string;
    owner_member_id: string | null;
    provider: string;
    external_account_id: string | null;
    label: string;
    status: SourceAccountRecord["status"];
    auth_mode: string | null;
    last_sync_at: Date | null;
  }>(
    `SELECT id, household_id, owner_member_id, provider, external_account_id,
            label, status::text, auth_mode, last_sync_at
     FROM source_accounts WHERE id = $1 LIMIT 1`,
    [sourceAccountId],
  );
  return result.rows[0] ? rowToSource(result.rows[0]) : null;
}

export async function listSourceAccounts(
  householdId: string,
  viewerMemberId: string,
  canSeeAll: boolean,
): Promise<SourceAccountRecord[]> {
  const result = await db.query<{
    id: string;
    household_id: string;
    owner_member_id: string | null;
    provider: string;
    external_account_id: string | null;
    label: string;
    status: SourceAccountRecord["status"];
    auth_mode: string | null;
    last_sync_at: Date | null;
  }>(
    `SELECT
       id, household_id, owner_member_id, provider, external_account_id,
       label, status::text, auth_mode, last_sync_at
     FROM source_accounts
     WHERE household_id = $1
       AND provider <> 'mcp'
       AND NOT (provider = 'whatsapp' AND auth_mode = 'linked-device-assistant')
       AND ($3::boolean OR owner_member_id = $2 OR owner_member_id IS NULL)
     ORDER BY created_at ASC`,
    [householdId, viewerMemberId, canSeeAll],
  );

  return result.rows.map(rowToSource);
}

export async function createSourceAccount(
  input: CreateSourceAccountInput,
): Promise<SourceAccountRecord> {
  const provider = normalizedText(input.provider, "provider", 80).toLowerCase();
  const label = normalizedText(input.label, "label", 120);
  const authMode = input.authMode?.trim().slice(0, 80) || undefined;
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    if (input.ownerMemberId) {
      const owner = await client.query(
        `SELECT 1 FROM members
         WHERE id = $1 AND household_id = $2 AND status = 'active'`,
        [input.ownerMemberId, input.householdId],
      );
      if (!owner.rowCount) {
        throw new SourceAccountValidationError(
          "ownerMemberId must be an active member of the household",
        );
      }
    }

    const result = await client.query<{
      id: string;
      household_id: string;
      owner_member_id: string | null;
      provider: string;
      external_account_id: string | null;
      label: string;
      status: SourceAccountRecord["status"];
      auth_mode: string | null;
      last_sync_at: Date | null;
    }>(
      `INSERT INTO source_accounts(
         household_id, owner_member_id, provider, label, status, auth_mode
       ) VALUES ($1, $2, $3, $4, 'disconnected', $5)
       RETURNING
         id, household_id, owner_member_id, provider, external_account_id,
         label, status::text, auth_mode, last_sync_at`,
      [input.householdId, input.ownerMemberId ?? null, provider, label, authMode ?? null],
    );

    const row = result.rows[0];
    if (!row) throw new Error("Failed to create source account");

    await client.query(
      `INSERT INTO event_outbox(
         household_id, event_type, aggregate_type, aggregate_id, payload
       ) VALUES ($1, 'source_account.created', 'source_account', $2, $3::jsonb)`,
      [
        row.household_id,
        row.id,
        JSON.stringify({
          sourceAccountId: row.id,
          provider: row.provider,
          ownerMemberId: row.owner_member_id,
        }),
      ],
    );

    await client.query("COMMIT");
    return rowToSource(row);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateSourceAccount(
  sourceAccountId: string,
  input: { householdId: string; label?: string; shared?: boolean; ownerMemberId: string },
): Promise<SourceAccountRecord | null> {
  const label = input.label === undefined ? undefined : normalizedText(input.label, "label", 120);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ owner_member_id: string | null }>(
      `SELECT owner_member_id FROM source_accounts WHERE id = $1 AND household_id = $2 FOR UPDATE`,
      [sourceAccountId, input.householdId],
    );
    if (!existing.rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }
    const nextOwner = input.shared === undefined
      ? existing.rows[0].owner_member_id
      : input.shared
        ? null
        : input.ownerMemberId;
    const result = await client.query<{
      id: string;
      household_id: string;
      owner_member_id: string | null;
      provider: string;
      external_account_id: string | null;
      label: string;
      status: SourceAccountRecord["status"];
      auth_mode: string | null;
      last_sync_at: Date | null;
    }>(
      `UPDATE source_accounts
       SET label = COALESCE($3, label), owner_member_id = $4, updated_at = now()
       WHERE id = $1 AND household_id = $2
       RETURNING id, household_id, owner_member_id, provider, external_account_id,
                 label, status::text, auth_mode, last_sync_at`,
      [sourceAccountId, input.householdId, label ?? null, nextOwner],
    );
    const row = result.rows[0];
    if (!row) throw new Error("failed_to_update_source_account");

    if (input.shared !== undefined) {
      const visibility = input.shared ? "family" : "private";
      await client.query(
        `UPDATE source_items
         SET owner_member_id = $2, visibility = $3::visibility_scope
         WHERE source_account_id = $1`,
        [sourceAccountId, nextOwner, visibility],
      );
      await client.query(
        `UPDATE conversations
         SET owner_member_id = $2, visibility = $3::visibility_scope, updated_at = now()
         WHERE source_account_id = $1`,
        [sourceAccountId, nextOwner, visibility],
      );
    }

    await client.query("COMMIT");
    return rowToSource(row);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteSourceAccount(
  sourceAccountId: string,
  householdId: string,
): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM source_accounts WHERE id = $1 AND household_id = $2`,
    [sourceAccountId, householdId],
  );
  return Boolean(result.rowCount);
}
