import { db } from "../../../database/client.js";

export interface SolWhatsappAccount {
  id: string;
  householdId: string;
  label: string;
  status: "connected" | "disconnected" | "error";
  linkedAt?: string;
  phoneJid?: string;
  displayName?: string;
  lastError?: string;
}

export interface SolWhatsappBinding {
  sourceAccountId: string;
  memberId: string;
  displayName: string;
  role: "owner" | "adult" | "member" | "child" | "guest";
  primaryJid?: string;
  alternateJid?: string;
  verifiedAt?: string;
  verificationExpiresAt?: string;
  disabled: boolean;
}

interface AccountRow {
  id: string;
  household_id: string;
  label: string;
  status: SolWhatsappAccount["status"];
  linked_at: Date | null;
  phone_jid: string | null;
  display_name: string | null;
  last_error: string | null;
}

function mapAccount(row: AccountRow): SolWhatsappAccount {
  return {
    id: row.id,
    householdId: row.household_id,
    label: row.label,
    status: row.status,
    linkedAt: row.linked_at?.toISOString(),
    phoneJid: row.phone_jid ?? undefined,
    displayName: row.display_name ?? undefined,
    lastError: row.last_error ?? undefined,
  };
}

const ACCOUNT_SELECT = `
  SELECT s.id, s.household_id, s.label, s.status::text AS status,
         w.linked_at, w.phone_jid, w.display_name, w.last_error
  FROM source_accounts s
  LEFT JOIN whatsapp_sessions w ON w.source_account_id = s.id
  WHERE s.provider = 'whatsapp' AND s.auth_mode = 'linked-device-assistant'
`;

export async function getSolWhatsappAccount(householdId: string): Promise<SolWhatsappAccount | null> {
  const result = await db.query<AccountRow>(
    `${ACCOUNT_SELECT} AND s.household_id = $1 LIMIT 1`,
    [householdId],
  );
  return result.rows[0] ? mapAccount(result.rows[0]) : null;
}

export async function getSolWhatsappAccountById(sourceAccountId: string): Promise<SolWhatsappAccount | null> {
  const result = await db.query<AccountRow>(
    `${ACCOUNT_SELECT} AND s.id = $1 LIMIT 1`,
    [sourceAccountId],
  );
  return result.rows[0] ? mapAccount(result.rows[0]) : null;
}

interface BindingRow {
  source_account_id: string;
  member_id: string;
  display_name: string;
  role: SolWhatsappBinding["role"];
  primary_jid: string | null;
  alternate_jid: string | null;
  verified_at: Date | null;
  verification_expires_at: Date | null;
  disabled_at: Date | null;
}

function mapBinding(row: BindingRow): SolWhatsappBinding {
  return {
    sourceAccountId: row.source_account_id,
    memberId: row.member_id,
    displayName: row.display_name,
    role: row.role,
    primaryJid: row.primary_jid ?? undefined,
    alternateJid: row.alternate_jid ?? undefined,
    verifiedAt: row.verified_at?.toISOString(),
    verificationExpiresAt: row.verification_expires_at?.toISOString(),
    disabled: Boolean(row.disabled_at),
  };
}

const BINDING_SELECT = `
  SELECT b.source_account_id, b.member_id, m.display_name, m.role::text AS role,
         b.primary_jid, b.alternate_jid, b.verified_at,
         b.verification_expires_at, b.disabled_at
  FROM sol_whatsapp_member_bindings b
  JOIN members m ON m.id = b.member_id
`;

export async function getSolWhatsappBinding(
  sourceAccountId: string,
  memberId: string,
): Promise<SolWhatsappBinding | null> {
  const result = await db.query<BindingRow>(
    `${BINDING_SELECT} WHERE b.source_account_id = $1 AND b.member_id = $2 LIMIT 1`,
    [sourceAccountId, memberId],
  );
  return result.rows[0] ? mapBinding(result.rows[0]) : null;
}

export async function listSolWhatsappBindings(sourceAccountId: string): Promise<SolWhatsappBinding[]> {
  const result = await db.query<BindingRow>(
    `${BINDING_SELECT}
     WHERE b.source_account_id = $1
     ORDER BY m.created_at ASC`,
    [sourceAccountId],
  );
  return result.rows.map(mapBinding);
}

export async function saveBindingChallenge(input: {
  sourceAccountId: string;
  memberId: string;
  verificationHash: string;
  expiresAt: Date;
}): Promise<void> {
  await db.query(
    `INSERT INTO sol_whatsapp_member_bindings(
       source_account_id, member_id, verification_hash, verification_expires_at,
       verified_at, disabled_at, updated_at
     ) VALUES ($1, $2, $3, $4, NULL, NULL, now())
     ON CONFLICT(source_account_id, member_id)
     DO UPDATE SET verification_hash = EXCLUDED.verification_hash,
                   verification_expires_at = EXCLUDED.verification_expires_at,
                   disabled_at = NULL,
                   updated_at = now()`,
    [input.sourceAccountId, input.memberId, input.verificationHash, input.expiresAt],
  );
}

export async function verifyBindingChallenge(input: {
  sourceAccountId: string;
  verificationHash: string;
  primaryJid: string;
  alternateJid?: string;
}): Promise<SolWhatsappBinding | null> {
  try {
    const result = await db.query<BindingRow>(
      `UPDATE sol_whatsapp_member_bindings b
       SET primary_jid = $3,
           alternate_jid = NULLIF($4, ''),
           verified_at = now(),
           verification_hash = NULL,
           verification_expires_at = NULL,
           disabled_at = NULL,
           last_seen_at = now(),
           updated_at = now()
       FROM members m
       WHERE b.source_account_id = $1
         AND b.verification_hash = $2
         AND b.verification_expires_at > now()
         AND m.id = b.member_id
         AND m.status = 'active'
         AND NOT EXISTS (
           SELECT 1
           FROM sol_whatsapp_member_bindings other
           WHERE other.source_account_id = b.source_account_id
             AND other.member_id <> b.member_id
             AND other.verified_at IS NOT NULL
             AND other.disabled_at IS NULL
             AND (
               other.primary_jid = $3 OR other.alternate_jid = $3 OR
               (NULLIF($4, '') IS NOT NULL AND
                (other.primary_jid = NULLIF($4, '') OR other.alternate_jid = NULLIF($4, '')))
             )
         )
       RETURNING b.source_account_id, b.member_id, m.display_name, m.role::text AS role,
                 b.primary_jid, b.alternate_jid, b.verified_at,
                 b.verification_expires_at, b.disabled_at`,
      [input.sourceAccountId, input.verificationHash, input.primaryJid, input.alternateJid ?? ""],
    );
    return result.rows[0] ? mapBinding(result.rows[0]) : null;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") return null;
    throw error;
  }
}

export async function resolveBindingByJids(
  sourceAccountId: string,
  jids: string[],
): Promise<SolWhatsappBinding | null> {
  if (!jids.length) return null;
  const result = await db.query<BindingRow>(
    `${BINDING_SELECT}
     WHERE b.source_account_id = $1
       AND b.verified_at IS NOT NULL
       AND b.disabled_at IS NULL
       AND m.status = 'active'
       AND (b.primary_jid = ANY($2::text[]) OR b.alternate_jid = ANY($2::text[]))
     LIMIT 1`,
    [sourceAccountId, jids],
  );
  return result.rows[0] ? mapBinding(result.rows[0]) : null;
}

export async function refreshBindingJids(
  sourceAccountId: string,
  memberId: string,
  primaryJid: string,
  alternateJid?: string,
): Promise<void> {
  try {
    await db.query(
      `UPDATE sol_whatsapp_member_bindings
       SET primary_jid = $3,
           alternate_jid = COALESCE(NULLIF($4, ''), alternate_jid),
           last_seen_at = now(), updated_at = now()
       WHERE source_account_id = $1 AND member_id = $2
         AND verified_at IS NOT NULL AND disabled_at IS NULL`,
      [sourceAccountId, memberId, primaryJid, alternateJid ?? ""],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      await db.query(
        `UPDATE sol_whatsapp_member_bindings
         SET last_seen_at = now(), updated_at = now()
         WHERE source_account_id = $1 AND member_id = $2`,
        [sourceAccountId, memberId],
      );
      return;
    }
    throw error;
  }
}

export async function revokeSolWhatsappBinding(
  sourceAccountId: string,
  memberId: string,
): Promise<void> {
  await db.query(
    `UPDATE sol_whatsapp_member_bindings
     SET disabled_at = now(), verification_hash = NULL,
         verification_expires_at = NULL, updated_at = now()
     WHERE source_account_id = $1 AND member_id = $2`,
    [sourceAccountId, memberId],
  );
}

export async function activeBindingForMember(
  sourceAccountId: string,
  memberId: string,
): Promise<SolWhatsappBinding | null> {
  const binding = await getSolWhatsappBinding(sourceAccountId, memberId);
  return binding?.verifiedAt && !binding.disabled ? binding : null;
}

export async function listActiveManagerBindings(
  sourceAccountId: string,
): Promise<SolWhatsappBinding[]> {
  const result = await db.query<BindingRow>(
    `${BINDING_SELECT}
     WHERE b.source_account_id = $1
       AND b.verified_at IS NOT NULL AND b.disabled_at IS NULL
       AND m.status = 'active' AND m.role IN ('owner', 'adult')
     ORDER BY m.created_at ASC`,
    [sourceAccountId],
  );
  return result.rows.map(mapBinding);
}

export async function recordSolWhatsappInteraction(input: {
  sourceAccountId: string;
  memberId: string;
  direction: "inbound" | "outbound";
  jid: string;
  bodyText: string;
  intent?: string;
}): Promise<void> {
  await db.query(
    `INSERT INTO sol_whatsapp_interactions(
       source_account_id, member_id, direction, jid, body_text, intent
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.sourceAccountId,
      input.memberId,
      input.direction,
      input.jid,
      input.bodyText.slice(0, 12000),
      input.intent?.slice(0, 80) ?? null,
    ],
  );
  const field = input.direction === "inbound" ? "last_inbound_at" : "last_outbound_at";
  await db.query(
    `INSERT INTO sol_whatsapp_member_state(source_account_id, member_id, ${field}, updated_at)
     VALUES ($1, $2, now(), now())
     ON CONFLICT(source_account_id, member_id)
     DO UPDATE SET ${field} = now(), updated_at = now()`,
    [input.sourceAccountId, input.memberId],
  );
}

export async function setLastProposal(
  sourceAccountId: string,
  memberId: string,
  proposalId: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO sol_whatsapp_member_state(source_account_id, member_id, last_proposal_id, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT(source_account_id, member_id)
     DO UPDATE SET last_proposal_id = EXCLUDED.last_proposal_id, updated_at = now()`,
    [sourceAccountId, memberId, proposalId],
  );
}

export async function getLastProposal(
  sourceAccountId: string,
  memberId: string,
): Promise<string | null> {
  const result = await db.query<{ last_proposal_id: string | null }>(
    `SELECT last_proposal_id
     FROM sol_whatsapp_member_state
     WHERE source_account_id = $1 AND member_id = $2`,
    [sourceAccountId, memberId],
  );
  return result.rows[0]?.last_proposal_id ?? null;
}

export async function getMemberContext(memberId: string): Promise<{
  memberId: string;
  householdId: string;
  displayName: string;
  role: SolWhatsappBinding["role"];
  timezone: string;
  householdName: string;
} | null> {
  const result = await db.query<{
    member_id: string;
    household_id: string;
    display_name: string;
    role: SolWhatsappBinding["role"];
    timezone: string;
    household_name: string;
  }>(
    `SELECT m.id AS member_id, m.household_id, m.display_name, m.role::text AS role,
            COALESCE(m.timezone, h.timezone) AS timezone, h.name AS household_name
     FROM members m JOIN households h ON h.id = m.household_id
     WHERE m.id = $1 AND m.status = 'active'`,
    [memberId],
  );
  const row = result.rows[0];
  return row
    ? {
        memberId: row.member_id,
        householdId: row.household_id,
        displayName: row.display_name,
        role: row.role,
        timezone: row.timezone,
        householdName: row.household_name,
      }
    : null;
}
