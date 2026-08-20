import { scoreIntelligenceCandidate } from "../../knowledge/intelligence-gate.js";

export interface CandidateSignal {
  candidate: boolean;
  score: number;
  reasons: string[];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Extracts human-readable text/captions from the normalized WhatsApp content.
 * Media without a caption intentionally returns undefined; media processing is a
 * separate future pipeline and should not be uploaded to AI just because it exists.
 */
export function extractWhatsappText(content: unknown): string | undefined {
  if (!content || typeof content !== "object") return undefined;
  const message = content as Record<string, any>;

  return (
    text(message.conversation) ??
    text(message.extendedTextMessage?.text) ??
    text(message.imageMessage?.caption) ??
    text(message.videoMessage?.caption) ??
    text(message.documentMessage?.caption) ??
    text(message.buttonsResponseMessage?.selectedDisplayText) ??
    text(message.listResponseMessage?.title) ??
    text(message.templateButtonReplyMessage?.selectedDisplayText) ??
    text(message.pollCreationMessage?.name) ??
    text(message.eventMessage?.name)
  );
}

export function detectWhatsappMessageType(content: unknown): string | undefined {
  if (!content || typeof content !== "object") return undefined;
  const keys = Object.keys(content as object);
  return keys.find(
    (key) =>
      (key === "conversation" || key.endsWith("Message")) &&
      key !== "senderKeyDistributionMessage",
  );
}

export function whatsappTimestamp(value: unknown): Date {
  let seconds: number | undefined;

  if (typeof value === "number") seconds = value;
  else if (typeof value === "bigint") seconds = Number(value);
  else if (value && typeof value === "object") {
    const candidate = value as { toNumber?: () => number; low?: number };
    if (typeof candidate.toNumber === "function") seconds = candidate.toNumber();
    else if (typeof candidate.low === "number") seconds = candidate.low;
  }

  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return new Date();
  return new Date(seconds * 1000);
}

/**
 * Compatibility wrapper for the WhatsApp realtime extraction pipeline. The shared
 * Intelligence Gate now owns the deterministic scoring rules; only the operational
 * route creates extraction_candidates here.
 */
export function scoreWhatsappCandidate(input: string | undefined): CandidateSignal {
  const decision = scoreIntelligenceCandidate({
    provider: "whatsapp",
    bodyText: input,
  });
  return {
    candidate: decision.routes.includes("operational"),
    score: decision.operationalScore,
    reasons: decision.reasons,
  };
}
