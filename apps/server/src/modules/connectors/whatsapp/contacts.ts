import { db } from "../../../database/client.js";
import type { WhatsappAccountRecord } from "./repository.js";

export interface WhatsappContactLike {
  id?: string;
  name?: string | null;
  notify?: string | null;
  verifiedName?: string | null;
}

export async function updateWhatsappContacts(
  account: WhatsappAccountRecord,
  contacts: WhatsappContactLike[],
): Promise<void> {
  for (const contact of contacts) {
    const jid = contact.id?.trim();
    if (!jid) continue;
    const label =
      contact.notify?.trim() ||
      contact.name?.trim() ||
      contact.verifiedName?.trim() ||
      null;

    const own = Boolean(account.phoneJid && account.phoneJid === jid);
    await db.query(
      `INSERT INTO identities(
         household_id, member_id, kind, provider, external_value,
         normalized_value, label, metadata
       ) VALUES ($1, $2, 'whatsapp_jid', 'whatsapp', $3, $3, $4, $5::jsonb)
       ON CONFLICT(household_id, kind, provider, external_value)
       DO UPDATE SET
         member_id = COALESCE(identities.member_id, EXCLUDED.member_id),
         label = COALESCE(EXCLUDED.label, identities.label),
         metadata = identities.metadata || EXCLUDED.metadata`,
      [
        account.householdId,
        own ? account.ownerMemberId ?? null : null,
        jid,
        label,
        JSON.stringify({ sourceAccountId: account.id }),
      ],
    );

    if (label) {
      await db.query(
        `UPDATE conversations
         SET title = COALESCE(title, $3), updated_at = now()
         WHERE source_account_id = $1 AND external_id = $2`,
        [account.id, jid, label],
      );
    }
  }
}
