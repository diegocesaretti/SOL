import { db } from "../../../database/client.js";

export interface WhatsappAccountRecord {
  id: string;
  householdId: string;
  ownerMemberId?: string;
  label: string;
  sourceStatus: "connected" | "disconnected" | "error";
  externalAccountId?: string;
  enabled: boolean;
  linkedAt?: string;
  phoneJid?: string;
  displayName?: string;
  historySyncComplete: boolean;
  lastConnectionAt?: string;
  lastDisconnectAt?: string;
  lastError?: string;
}

interface WhatsappAccountRow {
  id: string;
  household_id: string;
  owner_member_id: string | null;
  label: string;
  status: WhatsappAccountRecord["sourceStatus"];
  external_account_id: string | null;
  enabled: boolean | null;
  linked_at: Date | null;
  phone_jid: string | null;
  display_name: string | null;
  history_sync_complete: boolean | null;
  last_connection_at: Date | null;
  last_disconnect_at: Date | null;
  last_error: string | null;
}

function mapRow(row: WhatsappAccountRow): WhatsappAccountRecord {
  return {
    id: row.id,
    householdId: row.household_id,
    ownerMemberId: row.owner_member_id ?? undefined,
    label: row.label,
    sourceStatus: row.status,
    externalAccountId: row.external_account_id ?? undefined,
    enabled: row.enabled ?? true,
    linkedAt: row.linked_at?.toISOString(),
    phoneJid: row.phone_jid ?? undefined,
    displayName: row.display_name ?? undefined,
    historySyncComplete: row.history_sync_complete ?? false,
    lastConnectionAt: row.last_connection_at?.toISOString(),
    lastDisconnectAt: row.last_disconnect_at?.toISOString(),
    lastError: row.last_error ?? undefined,
  };
}

const SELECT_ACCOUNT = `
  SELECT
    s.id, s.household_id, s.owner_member_id, s.label, s.status::text AS status,
    s.external_account_id,
    w.enabled, w.linked_at, w.phone_jid, w.display_name,
    w.history_sync_complete, w.last_connection_at, w.last_disconnect_at,
    w.last_error
  FROM source_accounts s
  LEFT JOIN whatsapp_sessions w ON w.source_account_id = s.id
  WHERE s.provider = 'whatsapp'
    AND COALESCE(s.auth_mode, '') NOT LIKE 'plugin:%'
`;

export async function ensureWhatsappSessionRecord(sourceAccountId: string): Promise<void> {
  await db.query(
    `INSERT INTO whatsapp_sessions(source_account_id)
     VALUES ($1)
     ON CONFLICT(source_account_id) DO NOTHING`,
    [sourceAccountId],
  );
}

export async function getWhatsappAccount(
  sourceAccountId: string,
): Promise<WhatsappAccountRecord | null> {
  const result = await db.query<WhatsappAccountRow>(
    `${SELECT_ACCOUNT} AND s.id = $1 LIMIT 1`,
    [sourceAccountId],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export async function listWhatsappAccounts(
  householdId: string,
  viewerMemberId: string,
  canSeeAllMetadata: boolean,
): Promise<WhatsappAccountRecord[]> {
  const result = await db.query<WhatsappAccountRow>(
    `${SELECT_ACCOUNT}
       AND s.household_id = $1
       AND COALESCE(s.auth_mode, '') <> 'linked-device-assistant'
       AND ($3::boolean OR s.owner_member_id = $2 OR s.owner_member_id IS NULL)
     ORDER BY s.created_at ASC`,
    [householdId, viewerMemberId, canSeeAllMetadata],
  );
  return result.rows.map(mapRow);
}

export async function listWhatsappAutostartAccounts(): Promise<string[]> {
  const result = await db.query<{ id: string }>(`
    SELECT s.id
    FROM source_accounts s
    JOIN whatsapp_sessions w ON w.source_account_id = s.id
    WHERE s.provider = 'whatsapp'
      AND COALESCE(s.auth_mode, '') <> 'linked-device-assistant'
      AND COALESCE(s.auth_mode, '') NOT LIKE 'plugin:%'
      AND w.enabled = true
      AND w.linked_at IS NOT NULL
    ORDER BY s.created_at ASC
  `);
  return result.rows.map((row) => row.id);
}

export async function markWhatsappConnected(
  sourceAccountId: string,
  user?: { id?: string; name?: string | null },
): Promise<void> {
  const phoneJid = user?.id?.trim() || null;
  const displayName = user?.name?.trim() || null;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO whatsapp_sessions(
         source_account_id, linked_at, phone_jid, display_name,
         last_connection_at, last_error, updated_at
       ) VALUES ($1, now(), $2, $3, now(), NULL, now())
       ON CONFLICT(source_account_id)
       DO UPDATE SET
         linked_at = COALESCE(whatsapp_sessions.linked_at, now()),
         phone_jid = COALESCE(EXCLUDED.phone_jid, whatsapp_sessions.phone_jid),
         display_name = COALESCE(EXCLUDED.display_name, whatsapp_sessions.display_name),
         last_connection_at = now(), last_error = NULL, updated_at = now()`,
      [sourceAccountId, phoneJid, displayName],
    );
    await client.query(
      `UPDATE source_accounts
       SET status = 'connected',
           external_account_id = COALESCE($2, external_account_id),
           updated_at = now()
       WHERE id = $1 AND provider = 'whatsapp'`,
      [sourceAccountId, phoneJid],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markWhatsappDisconnected(
  sourceAccountId: string,
  error?: string,
): Promise<void> {
  const message = error?.slice(0, 2000) || null;
  const status = message ? "error" : "disconnected";
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO whatsapp_sessions(
         source_account_id, last_disconnect_at, last_error, updated_at
       ) VALUES ($1, now(), $2, now())
       ON CONFLICT(source_account_id)
       DO UPDATE SET last_disconnect_at = now(), last_error = $2, updated_at = now()`,
      [sourceAccountId, message],
    );
    await client.query(
      `UPDATE source_accounts SET status = $2::source_status, updated_at = now()
       WHERE id = $1 AND provider = 'whatsapp'`,
      [sourceAccountId, status],
    );
    await client.query("COMMIT");
  } catch (dbError) {
    await client.query("ROLLBACK");
    throw dbError;
  } finally {
    client.release();
  }
}

export async function markWhatsappHistoryComplete(sourceAccountId: string): Promise<void> {
  await db.query(
    `UPDATE whatsapp_sessions
     SET history_sync_complete = true, updated_at = now()
     WHERE source_account_id = $1`,
    [sourceAccountId],
  );
}

export async function clearWhatsappLinkState(sourceAccountId: string): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE whatsapp_sessions
       SET linked_at = NULL, phone_jid = NULL, display_name = NULL,
           history_sync_complete = false, last_error = NULL,
           last_disconnect_at = now(), updated_at = now()
       WHERE source_account_id = $1`,
      [sourceAccountId],
    );
    await client.query(
      `UPDATE source_accounts
       SET status = 'disconnected', external_account_id = NULL, updated_at = now()
       WHERE id = $1 AND provider = 'whatsapp'`,
      [sourceAccountId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listRecentWhatsappMessages(
  sourceAccountId: string,
  limit = 25,
) {
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const result = await db.query<{
    id: string;
    occurred_at: Date;
    body_text: string | null;
    raw_metadata: Record<string, unknown>;
    conversation_title: string | null;
  }>(
    `SELECT
       si.id, si.occurred_at, si.body_text, si.raw_metadata,
       c.title AS conversation_title
     FROM whatsapp_message_index wi
     JOIN source_items si ON si.id = wi.source_item_id
     LEFT JOIN messages m ON m.source_item_id = si.id
     LEFT JOIN conversations c ON c.id = m.conversation_id
     WHERE wi.source_account_id = $1
     ORDER BY si.occurred_at DESC
     LIMIT $2`,
    [sourceAccountId, safeLimit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    text: row.body_text,
    conversationTitle: row.conversation_title,
    metadata: row.raw_metadata,
  }));
}
