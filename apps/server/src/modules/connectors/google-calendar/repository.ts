import { db } from "../../../database/client.js";

export interface GoogleCalendarAccount {
  id: string;
  householdId: string;
  ownerMemberId?: string;
  label: string;
  status: "connected" | "disconnected" | "error";
  externalAccountId?: string;
  lastSyncAt?: string;
  googleEmail?: string;
}

export interface GoogleCalendarRecord {
  id: string;
  sourceAccountId: string;
  externalCalendarId: string;
  summary: string;
  timezone?: string;
  accessRole: string;
  primary: boolean;
  selectedForSync: boolean;
  selectedForWrite: boolean;
  lastSyncAt?: string;
}

export async function getGoogleCalendarAccount(sourceAccountId: string): Promise<GoogleCalendarAccount | null> {
  const result = await db.query<{
    id: string;
    household_id: string;
    owner_member_id: string | null;
    label: string;
    status: GoogleCalendarAccount["status"];
    external_account_id: string | null;
    last_sync_at: Date | null;
    google_account_email: string | null;
  }>(
    `SELECT sa.id, sa.household_id, sa.owner_member_id, sa.label, sa.status::text,
            sa.external_account_id, sa.last_sync_at, gc.google_account_email
     FROM source_accounts sa
     LEFT JOIN google_oauth_credentials gc ON gc.source_account_id = sa.id
     WHERE sa.id = $1 AND sa.provider = 'google_calendar'
     LIMIT 1`,
    [sourceAccountId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    householdId: row.household_id,
    ownerMemberId: row.owner_member_id ?? undefined,
    label: row.label,
    status: row.status,
    externalAccountId: row.external_account_id ?? undefined,
    lastSyncAt: row.last_sync_at?.toISOString(),
    googleEmail: row.google_account_email ?? undefined,
  };
}

export async function listGoogleCalendarAccounts(
  householdId: string,
  memberId: string,
  canSeeAll: boolean,
): Promise<GoogleCalendarAccount[]> {
  const result = await db.query<{
    id: string;
    household_id: string;
    owner_member_id: string | null;
    label: string;
    status: GoogleCalendarAccount["status"];
    external_account_id: string | null;
    last_sync_at: Date | null;
    google_account_email: string | null;
  }>(
    `SELECT sa.id, sa.household_id, sa.owner_member_id, sa.label, sa.status::text,
            sa.external_account_id, sa.last_sync_at, gc.google_account_email
     FROM source_accounts sa
     LEFT JOIN google_oauth_credentials gc ON gc.source_account_id = sa.id
     WHERE sa.household_id = $1
       AND sa.provider = 'google_calendar'
       AND ($3::boolean OR sa.owner_member_id = $2 OR sa.owner_member_id IS NULL)
     ORDER BY sa.created_at ASC`,
    [householdId, memberId, canSeeAll],
  );
  return result.rows.map((row) => ({
    id: row.id,
    householdId: row.household_id,
    ownerMemberId: row.owner_member_id ?? undefined,
    label: row.label,
    status: row.status,
    externalAccountId: row.external_account_id ?? undefined,
    lastSyncAt: row.last_sync_at?.toISOString(),
    googleEmail: row.google_account_email ?? undefined,
  }));
}

export async function listGoogleCalendars(sourceAccountId: string): Promise<GoogleCalendarRecord[]> {
  const result = await db.query<{
    id: string;
    source_account_id: string;
    external_calendar_id: string;
    summary: string;
    timezone: string | null;
    access_role: string;
    is_primary: boolean;
    selected_for_sync: boolean;
    selected_for_write: boolean;
    last_sync_at: Date | null;
  }>(
    `SELECT id, source_account_id, external_calendar_id, summary, timezone, access_role,
            is_primary, selected_for_sync, selected_for_write, last_sync_at
     FROM google_calendars
     WHERE source_account_id = $1
     ORDER BY is_primary DESC, summary ASC`,
    [sourceAccountId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    sourceAccountId: row.source_account_id,
    externalCalendarId: row.external_calendar_id,
    summary: row.summary,
    timezone: row.timezone ?? undefined,
    accessRole: row.access_role,
    primary: row.is_primary,
    selectedForSync: row.selected_for_sync,
    selectedForWrite: row.selected_for_write,
    lastSyncAt: row.last_sync_at?.toISOString(),
  }));
}

export async function configureGoogleCalendar(
  calendarId: string,
  sourceAccountId: string,
  input: { selectedForSync?: boolean; selectedForWrite?: boolean },
): Promise<GoogleCalendarRecord | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (input.selectedForWrite === true) {
      await client.query(
        `UPDATE google_calendars SET selected_for_write = false, updated_at = now()
         WHERE source_account_id = $1`,
        [sourceAccountId],
      );
    }
    const result = await client.query<{
      id: string;
      source_account_id: string;
      external_calendar_id: string;
      summary: string;
      timezone: string | null;
      access_role: string;
      is_primary: boolean;
      selected_for_sync: boolean;
      selected_for_write: boolean;
      last_sync_at: Date | null;
    }>(
      `UPDATE google_calendars
       SET selected_for_sync = COALESCE($3, selected_for_sync),
           selected_for_write = COALESCE($4, selected_for_write),
           updated_at = now()
       WHERE id = $1 AND source_account_id = $2
       RETURNING id, source_account_id, external_calendar_id, summary, timezone,
                 access_role, is_primary, selected_for_sync, selected_for_write, last_sync_at`,
      [calendarId, sourceAccountId, input.selectedForSync ?? null, input.selectedForWrite ?? null],
    );
    await client.query("COMMIT");
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      sourceAccountId: row.source_account_id,
      externalCalendarId: row.external_calendar_id,
      summary: row.summary,
      timezone: row.timezone ?? undefined,
      accessRole: row.access_role,
      primary: row.is_primary,
      selectedForSync: row.selected_for_sync,
      selectedForWrite: row.selected_for_write,
      lastSyncAt: row.last_sync_at?.toISOString(),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markGoogleAccountDisconnected(sourceAccountId: string): Promise<void> {
  await db.query(
    `UPDATE source_accounts
     SET status = 'disconnected', last_sync_at = NULL, updated_at = now()
     WHERE id = $1 AND provider = 'google_calendar'`,
    [sourceAccountId],
  );
}
