import { createHash } from "node:crypto";
import { db } from "../../../database/client.js";
import { gmailGet } from "./client.js";
import {
  ensureGmailAccountRecord,
  getGmailAccount,
  markGmailError,
  markGmailSyncSuccess,
} from "./repository.js";

interface GmailProfile {
  emailAddress?: string;
  historyId?: string;
  messagesTotal?: number;
  threadsTotal?: number;
}
interface GmailListResponse {
  messages?: Array<{ id?: string; threadId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}
interface GmailHeader { name?: string; value?: string }
interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}
interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailPart;
}

function header(part: GmailPart | undefined, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return part?.headers?.find((item) => item.name?.toLowerCase() === wanted)?.value?.trim() || undefined;
}

function decodeBody(data: string | undefined): string {
  if (!data) return "";
  try { return Buffer.from(data, "base64url").toString("utf8"); } catch { return ""; }
}

function htmlToText(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function collectBodies(part: GmailPart | undefined, plain: string[], html: string[]): void {
  if (!part) return;
  const mime = part.mimeType?.toLowerCase();
  const decoded = decodeBody(part.body?.data);
  if (decoded && mime === "text/plain") plain.push(decoded);
  else if (decoded && mime === "text/html") html.push(decoded);
  for (const child of part.parts ?? []) collectBodies(child, plain, html);
}

export function extractGmailText(message: GmailMessage): string | undefined {
  const plain: string[] = [];
  const html: string[] = [];
  collectBodies(message.payload, plain, html);
  const value = (plain.join("\n\n").trim() || htmlToText(html.join("\n\n"))).trim();
  return value ? value.slice(0, 24_000) : message.snippet?.trim().slice(0, 4000) || undefined;
}

function emailAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const angle = value.match(/<([^<>\s]+@[^<>\s]+)>/);
  const bare = value.match(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
  return (angle?.[1] || bare?.[1])?.trim().toLowerCase();
}

function occurredAt(message: GmailMessage): Date {
  const ms = Number(message.internalDate);
  if (Number.isFinite(ms) && ms > 0) return new Date(ms);
  const dateHeader = header(message.payload, "date");
  const parsed = dateHeader ? new Date(dateHeader) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function contentHash(message: GmailMessage, text: string | undefined): string {
  return createHash("sha256")
    .update([header(message.payload, "subject"), header(message.payload, "from"), text].filter(Boolean).join("\n"))
    .digest("hex");
}

async function upsertEmailIdentity(input: {
  householdId: string;
  ownerMemberId?: string;
  address?: string;
  label?: string;
  own: boolean;
}): Promise<string | null> {
  if (!input.address) return null;
  const result = await db.query<{ id: string }>(
    `INSERT INTO identities(
       household_id, member_id, kind, provider, external_value, normalized_value, label, metadata
     ) VALUES ($1,$2,'email','gmail',$3,$3,$4,$5::jsonb)
     ON CONFLICT(household_id, kind, provider, external_value)
     DO UPDATE SET member_id = COALESCE(identities.member_id, EXCLUDED.member_id),
                   label = COALESCE(EXCLUDED.label, identities.label),
                   metadata = identities.metadata || EXCLUDED.metadata
     RETURNING id`,
    [
      input.householdId,
      input.own ? input.ownerMemberId ?? null : null,
      input.address,
      input.label ?? null,
      JSON.stringify({ source: "gmail" }),
    ],
  );
  return result.rows[0]?.id ?? null;
}

async function ingestMessage(
  account: NonNullable<Awaited<ReturnType<typeof getGmailAccount>>>,
  profileEmail: string | undefined,
  message: GmailMessage,
): Promise<boolean> {
  if (!message.id) return false;
  const existing = await db.query(
    `SELECT 1 FROM source_items WHERE source_account_id = $1 AND kind = 'email' AND external_id = $2 LIMIT 1`,
    [account.id, message.id],
  );
  if (existing.rowCount) return false;

  const subject = header(message.payload, "subject") || "(sin asunto)";
  const from = header(message.payload, "from");
  const to = header(message.payload, "to");
  const cc = header(message.payload, "cc");
  const senderAddress = emailAddress(from);
  const own = Boolean(profileEmail && senderAddress && senderAddress === profileEmail.toLowerCase());
  const text = extractGmailText(message);
  const visibility = account.ownerMemberId ? "private" : "family";
  const senderIdentityId = await upsertEmailIdentity({
    householdId: account.householdId,
    ownerMemberId: account.ownerMemberId,
    address: senderAddress,
    label: from,
    own,
  });
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const conversationResult = await client.query<{ id: string }>(
      `INSERT INTO conversations(
         household_id, source_account_id, external_id, title, kind, owner_member_id, visibility, metadata
       ) VALUES ($1,$2,$3,$4,'email_thread',$5,$6::visibility_scope,$7::jsonb)
       ON CONFLICT(source_account_id, external_id)
       DO UPDATE SET title = COALESCE(EXCLUDED.title, conversations.title), updated_at = now()
       RETURNING id`,
      [
        account.householdId,
        account.id,
        message.threadId || message.id,
        subject,
        account.ownerMemberId ?? null,
        visibility,
        JSON.stringify({ provider: "gmail", threadId: message.threadId ?? null }),
      ],
    );
    const conversationId = conversationResult.rows[0]?.id;
    if (!conversationId) throw new Error("failed_to_create_gmail_conversation");
    if (senderIdentityId) {
      await client.query(
        `INSERT INTO conversation_participants(conversation_id, identity_id, display_name)
         VALUES ($1,$2,$3)
         ON CONFLICT(conversation_id, identity_id)
         DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, conversation_participants.display_name)`,
        [conversationId, senderIdentityId, from ?? null],
      );
    }
    const source = await client.query<{ id: string }>(
      `INSERT INTO source_items(
         household_id, source_account_id, external_id, kind, owner_member_id, visibility,
         occurred_at, title, body_text, content_hash, raw_metadata
       ) VALUES ($1,$2,$3,'email',$4,$5::visibility_scope,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT(source_account_id, kind, external_id) DO NOTHING
       RETURNING id`,
      [
        account.householdId,
        account.id,
        message.id,
        account.ownerMemberId ?? null,
        visibility,
        occurredAt(message),
        subject,
        text ?? null,
        contentHash(message, text),
        JSON.stringify({
          provider: "gmail",
          threadId: message.threadId ?? null,
          from: from ?? null,
          fromAddress: senderAddress ?? null,
          to: to ?? null,
          cc: cc ?? null,
          messageIdHeader: header(message.payload, "message-id") ?? null,
          labelIds: message.labelIds ?? [],
          historyId: message.historyId ?? null,
          snippet: message.snippet?.slice(0, 1000) ?? null,
          hasText: Boolean(text),
          fromMe: own,
        }),
      ],
    );
    const sourceItemId = source.rows[0]?.id;
    if (!sourceItemId) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `INSERT INTO messages(source_item_id, conversation_id, sender_identity_id, is_from_owner)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT(source_item_id) DO NOTHING`,
      [sourceItemId, conversationId, senderIdentityId, own],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function listRecentMessageIds(sourceAccountId: string, initial: boolean): Promise<string[]> {
  const query = initial ? "newer_than:90d" : "newer_than:2d";
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ maxResults: "100", q: query });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await gmailGet<GmailListResponse>(
      sourceAccountId,
      `/users/me/messages?${params.toString()}`,
    );
    for (const item of page.messages ?? []) {
      if (item.id) ids.push(item.id);
      if (ids.length >= (initial ? 500 : 300)) break;
    }
    pageToken = ids.length < (initial ? 500 : 300) ? page.nextPageToken : undefined;
  } while (pageToken);
  return ids;
}

export async function syncGmailAccount(sourceAccountId: string): Promise<{
  scanned: number;
  imported: number;
  emailAddress?: string;
}> {
  await ensureGmailAccountRecord(sourceAccountId);
  const account = await getGmailAccount(sourceAccountId);
  if (!account) throw new Error("Gmail source account not found");
  try {
    const profile = await gmailGet<GmailProfile>(sourceAccountId, "/users/me/profile");
    const ids = await listRecentMessageIds(sourceAccountId, !account.lastSyncAt);
    let imported = 0;
    for (const id of ids) {
      const exists = await db.query(
        `SELECT 1 FROM source_items WHERE source_account_id = $1 AND kind = 'email' AND external_id = $2 LIMIT 1`,
        [sourceAccountId, id],
      );
      if (exists.rowCount) continue;
      const message = await gmailGet<GmailMessage>(
        sourceAccountId,
        `/users/me/messages/${encodeURIComponent(id)}?format=full`,
      );
      if (await ingestMessage(account, profile.emailAddress, message)) imported += 1;
    }
    await markGmailSyncSuccess(sourceAccountId, {
      emailAddress: profile.emailAddress,
      historyId: profile.historyId,
    });
    return { scanned: ids.length, imported, emailAddress: profile.emailAddress };
  } catch (error) {
    await markGmailError(sourceAccountId, error).catch(() => undefined);
    throw error;
  }
}
