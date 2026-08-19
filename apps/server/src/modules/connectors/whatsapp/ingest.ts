import { createHash } from "node:crypto";
import {
  extractMessageContent,
  normalizeMessageContent,
  type WAMessage,
} from "baileys";
import { db } from "../../../database/client.js";
import {
  detectWhatsappMessageType,
  extractWhatsappText,
  scoreWhatsappCandidate,
  whatsappTimestamp,
} from "./message-content.js";
import type { WhatsappAccountRecord } from "./repository.js";

export type WhatsappIngestOrigin = "realtime" | "history";

function isIgnoredChat(jid: string): boolean {
  return (
    jid === "status@broadcast" ||
    jid.endsWith("@broadcast") ||
    jid.endsWith("@newsletter")
  );
}

function isGroup(jid: string): boolean {
  return jid.endsWith("@g.us");
}

function normalizedHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function senderJid(message: WAMessage, selfJid?: string): string | undefined {
  const remoteJid = message.key.remoteJid ?? undefined;
  if (message.key.fromMe) return selfJid ?? message.key.participant ?? undefined;
  if (remoteJid && isGroup(remoteJid)) {
    return message.key.participant ?? message.participant ?? undefined;
  }
  return remoteJid;
}

async function upsertIdentity(
  client: Awaited<ReturnType<typeof db.connect>>,
  account: WhatsappAccountRecord,
  jid: string | undefined,
  displayName: string | undefined,
  ownIdentity: boolean,
): Promise<string | null> {
  if (!jid) return null;

  const result = await client.query<{ id: string }>(
    `INSERT INTO identities(
       household_id, member_id, kind, provider, external_value,
       normalized_value, label, metadata
     ) VALUES ($1, $2, 'whatsapp_jid', 'whatsapp', $3, $3, $4, $5::jsonb)
     ON CONFLICT(household_id, kind, provider, external_value)
     DO UPDATE SET
       member_id = COALESCE(identities.member_id, EXCLUDED.member_id),
       label = COALESCE(EXCLUDED.label, identities.label),
       metadata = identities.metadata || EXCLUDED.metadata
     RETURNING id`,
    [
      account.householdId,
      ownIdentity ? account.ownerMemberId ?? null : null,
      jid,
      displayName ?? null,
      JSON.stringify({ sourceAccountId: account.id }),
    ],
  );
  return result.rows[0]?.id ?? null;
}

export async function ingestWhatsappMessage(
  account: WhatsappAccountRecord,
  message: WAMessage,
  origin: WhatsappIngestOrigin,
  selfJid?: string,
  upsertType?: string,
): Promise<{ stored: boolean; candidate: boolean }> {
  const remoteJid = message.key.remoteJid ?? undefined;
  const messageId = message.key.id ?? undefined;
  if (!remoteJid || !messageId || !message.message || isIgnoredChat(remoteJid)) {
    return { stored: false, candidate: false };
  }

  const normalized = normalizeMessageContent(message.message);
  const content = extractMessageContent(normalized) ?? normalized;
  if (!content) return { stored: false, candidate: false };

  const bodyText = extractWhatsappText(content);
  const messageType = detectWhatsappMessageType(content);
  const fromMe = Boolean(message.key.fromMe);
  const authorJid = senderJid(message, selfJid);
  const occurredAt = whatsappTimestamp(message.messageTimestamp);
  const visibility = account.ownerMemberId ? "private" : "family";
  const externalId = `${remoteJid}:${messageId}`;
  const signal = scoreWhatsappCandidate(bodyText);

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const conversationResult = await client.query<{ id: string }>(
      `INSERT INTO conversations(
         household_id, source_account_id, external_id, title, kind,
         owner_member_id, visibility, metadata
       ) VALUES ($1, $2, $3, NULL, $4, $5, $6::visibility_scope, $7::jsonb)
       ON CONFLICT(source_account_id, external_id)
       DO UPDATE SET updated_at = now()
       RETURNING id`,
      [
        account.householdId,
        account.id,
        remoteJid,
        isGroup(remoteJid) ? "group" : "direct",
        account.ownerMemberId ?? null,
        visibility,
        JSON.stringify({ whatsappJid: remoteJid }),
      ],
    );
    const conversationId = conversationResult.rows[0]?.id;
    if (!conversationId) throw new Error("Failed to create WhatsApp conversation");

    const senderIdentityId = await upsertIdentity(
      client,
      account,
      authorJid,
      message.pushName ?? undefined,
      fromMe,
    );

    if (senderIdentityId) {
      await client.query(
        `INSERT INTO conversation_participants(conversation_id, identity_id, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT(conversation_id, identity_id)
         DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, conversation_participants.display_name)`,
        [conversationId, senderIdentityId, message.pushName ?? null],
      );
    }

    const metadata = {
      provider: "whatsapp",
      origin,
      upsertType: upsertType ?? null,
      remoteJid,
      senderJid: authorJid ?? null,
      participant: message.key.participant ?? message.participant ?? null,
      fromMe,
      pushName: message.pushName ?? null,
      messageType: messageType ?? null,
      hasText: Boolean(bodyText),
      candidateScore: signal.score,
      candidateReasons: signal.reasons,
    };

    const sourceResult = await client.query<{ id: string; inserted: boolean }>(
      `INSERT INTO source_items(
         household_id, source_account_id, external_id, kind,
         owner_member_id, visibility, occurred_at, title, body_text,
         content_hash, raw_metadata
       ) VALUES ($1, $2, $3, 'message', $4, $5::visibility_scope, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT(source_account_id, kind, external_id)
       DO UPDATE SET
         body_text = COALESCE(EXCLUDED.body_text, source_items.body_text),
         content_hash = COALESCE(EXCLUDED.content_hash, source_items.content_hash),
         raw_metadata = source_items.raw_metadata || EXCLUDED.raw_metadata
       RETURNING id, (xmax = 0) AS inserted`,
      [
        account.householdId,
        account.id,
        externalId,
        account.ownerMemberId ?? null,
        visibility,
        occurredAt,
        message.pushName ?? null,
        bodyText ?? null,
        bodyText ? normalizedHash(bodyText) : null,
        JSON.stringify(metadata),
      ],
    );
    const sourceItem = sourceResult.rows[0];
    if (!sourceItem) throw new Error("Failed to persist WhatsApp source item");

    await client.query(
      `INSERT INTO messages(
         source_item_id, conversation_id, sender_identity_id, is_from_owner
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT(source_item_id)
       DO UPDATE SET
         conversation_id = EXCLUDED.conversation_id,
         sender_identity_id = COALESCE(EXCLUDED.sender_identity_id, messages.sender_identity_id),
         is_from_owner = EXCLUDED.is_from_owner`,
      [sourceItem.id, conversationId, senderIdentityId, fromMe],
    );

    await client.query(
      `INSERT INTO whatsapp_message_index(
         source_account_id, remote_jid, message_id, source_item_id, message_type
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT(source_account_id, remote_jid, message_id)
       DO UPDATE SET source_item_id = EXCLUDED.source_item_id,
                     message_type = COALESCE(EXCLUDED.message_type, whatsapp_message_index.message_type)`,
      [account.id, remoteJid, messageId, sourceItem.id, messageType ?? null],
    );

    let candidateCreated = false;
    if (signal.candidate && bodyText) {
      const candidateResult = await client.query<{ id: string }>(
        `INSERT INTO extraction_candidates(
           household_id, source_item_id, owner_member_id, source_provider,
           score, reasons
         ) VALUES ($1, $2, $3, 'whatsapp', $4, $5::jsonb)
         ON CONFLICT(source_item_id) DO NOTHING
         RETURNING id`,
        [
          account.householdId,
          sourceItem.id,
          account.ownerMemberId ?? null,
          signal.score,
          JSON.stringify(signal.reasons),
        ],
      );

      const candidateId = candidateResult.rows[0]?.id;
      if (candidateId) {
        candidateCreated = true;
        await client.query(
          `INSERT INTO event_outbox(
             household_id, event_type, aggregate_type, aggregate_id, payload
           ) VALUES ($1, 'whatsapp.candidate.detected', 'extraction_candidate', $2, $3::jsonb)`,
          [
            account.householdId,
            candidateId,
            JSON.stringify({
              candidateId,
              sourceItemId: sourceItem.id,
              ownerMemberId: account.ownerMemberId ?? null,
            }),
          ],
        );
      }
    }

    await client.query("COMMIT");
    return { stored: sourceItem.inserted, candidate: candidateCreated };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateWhatsappConversationTitles(
  sourceAccountId: string,
  chats: Array<{ id?: string; name?: string | null; subject?: string | null }>,
): Promise<void> {
  for (const chat of chats) {
    const jid = chat.id?.trim();
    const title = chat.name?.trim() || chat.subject?.trim();
    if (!jid || !title) continue;
    await db.query(
      `UPDATE conversations
       SET title = $3, updated_at = now()
       WHERE source_account_id = $1 AND external_id = $2`,
      [sourceAccountId, jid, title],
    );
  }
}
