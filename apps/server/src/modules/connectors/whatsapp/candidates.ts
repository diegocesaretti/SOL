import { db } from "../../../database/client.js";

export interface WhatsappCandidateView {
  id: string;
  occurredAt: string;
  text?: string;
  conversationTitle?: string;
  score: number;
  reasons: string[];
  status: "pending" | "analyzed" | "ignored" | "failed";
  kind: string;
  confidence?: number;
  extracted?: Record<string, unknown>;
  error?: string;
}

export async function listRecentWhatsappCandidates(
  sourceAccountId: string,
  limit = 25,
): Promise<WhatsappCandidateView[]> {
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const result = await db.query<{
    id: string;
    occurred_at: Date;
    body_text: string | null;
    conversation_title: string | null;
    score: number;
    reasons: unknown;
    status: WhatsappCandidateView["status"];
    kind: string;
    confidence: number | null;
    extracted: Record<string, unknown> | null;
    error: string | null;
  }>(
    `SELECT
       ec.id,
       si.occurred_at,
       si.body_text,
       c.title AS conversation_title,
       ec.score,
       ec.reasons,
       ec.status::text,
       ec.kind::text,
       ec.confidence,
       ec.extracted,
       ec.error
     FROM extraction_candidates ec
     JOIN source_items si ON si.id = ec.source_item_id
     LEFT JOIN messages m ON m.source_item_id = si.id
     LEFT JOIN conversations c ON c.id = m.conversation_id
     WHERE si.source_account_id = $1
       AND ec.source_provider = 'whatsapp'
     ORDER BY si.occurred_at DESC
     LIMIT $2`,
    [sourceAccountId, safeLimit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    text: row.body_text ?? undefined,
    conversationTitle: row.conversation_title ?? undefined,
    score: Number(row.score),
    reasons: Array.isArray(row.reasons)
      ? row.reasons.filter((item): item is string => typeof item === "string")
      : [],
    status: row.status,
    kind: row.kind,
    confidence: row.confidence ?? undefined,
    extracted: row.extracted ?? undefined,
    error: row.error ?? undefined,
  }));
}
