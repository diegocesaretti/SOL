import { db } from "../../../database/client.js";

export interface GmailAccount {
  id: string;
  householdId: string;
  ownerMemberId?: string;
  label: string;
  status: "connected" | "disconnected" | "error";
  emailAddress?: string;
  historyId?: string;
  lastSyncAt?: string;
  lastError?: string;
}

function mapRow(row: {
  id: string;
  household_id: string;
  owner_member_id: string | null;
  label: string;
  status: GmailAccount["status"];
  email_address: string | null;
  history_id: string | null;
  last_sync_at: Date | null;
  last_error: string | null;
}): GmailAccount {
  return {
    id: row.id,
    householdId: row.household_id,
    ownerMemberId: row.owner_member_id ?? undefined,
    label: row.label,
    status: row.status,
    emailAddress: row.email_address ?? undefined,
    historyId: row.history_id ?? undefined,
    lastSyncAt: row.last_sync_at?.toISOString(),
    lastError: row.last_error ?? undefined,
  };
}

export async function ensureGmailAccountRecord(sourceAccountId: string): Promise<void> {
  await db.query(
    `INSERT INTO gmail_accounts(source_account_id)
     VALUES ($1)
     ON CONFLICT(source_account_id) DO NOTHING`,
    [sourceAccountId],
  );
}

export async function getGmailAccount(sourceAccountId: string): Promise<GmailAccount | null> {
  const result = await db.query<{
    id: string; household_id: string; owner_member_id: string | null; label: string;
    status: GmailAccount["status"]; email_address: string | null; history_id: string | null;
    last_sync_at: Date | null; last_error: string | null;
  }>(
    `SELECT sa.id, sa.household_id, sa.owner_member_id, sa.label, sa.status::text,
            ga.email_address, ga.history_id, ga.last_sync_at, ga.last_error
     FROM source_accounts sa
     LEFT JOIN gmail_accounts ga ON ga.source_account_id = sa.id
     WHERE sa.id = $1 AND sa.provider = 'gmail'
     LIMIT 1`,
    [sourceAccountId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listGmailAccounts(
  householdId: string,
  memberId: string,
  canSeeAll: boolean,
): Promise<GmailAccount[]> {
  const result = await db.query<{
    id: string; household_id: string; owner_member_id: string | null; label: string;
    status: GmailAccount["status"]; email_address: string | null; history_id: string | null;
    last_sync_at: Date | null; last_error: string | null;
  }>(
    `SELECT sa.id, sa.household_id, sa.owner_member_id, sa.label, sa.status::text,
            ga.email_address, ga.history_id, ga.last_sync_at, ga.last_error
     FROM source_accounts sa
     LEFT JOIN gmail_accounts ga ON ga.source_account_id = sa.id
     WHERE sa.household_id = $1 AND sa.provider = 'gmail'
       AND ($3::boolean OR sa.owner_member_id = $2 OR sa.owner_member_id IS NULL)
     ORDER BY sa.created_at ASC`,
    [householdId, memberId, canSeeAll],
  );
  return result.rows.map(mapRow);
}

export async function markGmailConnected(
  sourceAccountId: string,
  profile: { emailAddress?: string; historyId?: string },
): Promise<void> {
  await ensureGmailAccountRecord(sourceAccountId);
  await db.query(
    `UPDATE gmail_accounts
     SET email_address = COALESCE($2, email_address),
         history_id = COALESCE($3, history_id),
         last_error = NULL,
         updated_at = now()
     WHERE source_account_id = $1`,
    [sourceAccountId, profile.emailAddress ?? null, profile.historyId ?? null],
  );
  await db.query(
    `UPDATE source_accounts
     SET status = 'connected',
         external_account_id = COALESCE($2, external_account_id),
         updated_at = now()
     WHERE id = $1 AND provider = 'gmail'`,
    [sourceAccountId, profile.emailAddress ?? null],
  );
}

export async function markGmailSyncSuccess(
  sourceAccountId: string,
  input: { emailAddress?: string; historyId?: string },
): Promise<void> {
  await ensureGmailAccountRecord(sourceAccountId);
  await db.query(
    `UPDATE gmail_accounts
     SET email_address = COALESCE($2, email_address),
         history_id = COALESCE($3, history_id),
         last_sync_at = now(),
         last_error = NULL,
         updated_at = now()
     WHERE source_account_id = $1`,
    [sourceAccountId, input.emailAddress ?? null, input.historyId ?? null],
  );
  await db.query(
    `UPDATE source_accounts
     SET status = 'connected',
         external_account_id = COALESCE($2, external_account_id),
         last_sync_at = now(),
         updated_at = now()
     WHERE id = $1 AND provider = 'gmail'`,
    [sourceAccountId, input.emailAddress ?? null],
  );
}

export async function markGmailError(sourceAccountId: string, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  await ensureGmailAccountRecord(sourceAccountId);
  await db.query(
    `UPDATE gmail_accounts SET last_error = $2, updated_at = now() WHERE source_account_id = $1`,
    [sourceAccountId, message],
  );
  await db.query(
    `UPDATE source_accounts SET status = 'error', updated_at = now() WHERE id = $1 AND provider = 'gmail'`,
    [sourceAccountId],
  );
}

export async function markGmailDisconnected(sourceAccountId: string): Promise<void> {
  await ensureGmailAccountRecord(sourceAccountId);
  await db.query(
    `UPDATE gmail_accounts SET last_error = NULL, updated_at = now() WHERE source_account_id = $1`,
    [sourceAccountId],
  );
  await db.query(
    `UPDATE source_accounts SET status = 'disconnected', updated_at = now() WHERE id = $1 AND provider = 'gmail'`,
    [sourceAccountId],
  );
}
