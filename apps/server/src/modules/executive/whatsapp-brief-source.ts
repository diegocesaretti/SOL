export const WHATSAPP_INPUT_EXTERNAL = "WHATSAPP_INPUT_EXTERNAL" as const;
const REQUIRED_EXCLUSIONS = ["CODEX_CONTROL_HUMAN", "CODEX_CONTROL_ASSISTANT", "CODEX_CONTROL_MIRROR"] as const;

export interface SafeMorningWhatsappSummary {
  summary: string;
  sourceClass: typeof WHATSAPP_INPUT_EXTERNAL;
  controlChannelExcluded: true;
  excludedSourceClasses: string[];
  effectiveAfter?: string;
  oldestMessageAt?: string;
  newestMessageAt?: string;
  selectedMessages: number;
}

export function validateMorningWhatsappSummary(value: unknown): SafeMorningWhatsappSummary {
  if (!value || typeof value !== "object") throw new Error("unsafe_whatsapp_summary_missing_policy");
  const result = value as Record<string, unknown>;
  const excluded = Array.isArray(result.excludedSourceClasses)
    ? result.excludedSourceClasses.filter((item): item is string => typeof item === "string")
    : [];
  if (result.sourceClass !== WHATSAPP_INPUT_EXTERNAL || result.controlChannelExcluded !== true) {
    throw new Error("unsafe_whatsapp_summary_control_channel_not_excluded");
  }
  for (const required of REQUIRED_EXCLUSIONS) {
    if (!excluded.includes(required)) throw new Error(`unsafe_whatsapp_summary_missing_${required}`);
  }
  const summary = typeof result.summary === "string" ? result.summary.trim() : "";
  if (!summary) throw new Error("unsafe_whatsapp_summary_empty");
  return {
    summary,
    sourceClass: WHATSAPP_INPUT_EXTERNAL,
    controlChannelExcluded: true,
    excludedSourceClasses: excluded,
    effectiveAfter: typeof result.effectiveAfter === "string" ? result.effectiveAfter : undefined,
    oldestMessageAt: typeof result.oldestMessageAt === "string" ? result.oldestMessageAt : undefined,
    newestMessageAt: typeof result.newestMessageAt === "string" ? result.newestMessageAt : undefined,
    selectedMessages: Number.isFinite(Number(result.selectedMessages)) ? Number(result.selectedMessages) : 0,
  };
}

export async function fetchMorningWhatsappSummary(input: {
  baseUrl: string;
  after: string;
  limit: number;
}): Promise<SafeMorningWhatsappSummary> {
  const response = await fetch(`${input.baseUrl.replace(/\/$/, "")}/api/llm/summarize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      after: input.after,
      limit: input.limit,
      focus: "Morning Brief: resumí sólo conversaciones WhatsApp externas y vigentes. Excluí por completo el canal donde el usuario conversa con Codex y cualquier copia espejo de ese chat dentro de una cuenta INPUT.",
    }),
    signal: AbortSignal.timeout(120_000),
  });
  let body: unknown = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const detail = body && typeof body === "object" && "error" in body ? String((body as { error?: unknown }).error) : `HTTP ${response.status}`;
    throw new Error(`whatsapp_summary_failed: ${detail}`);
  }
  return validateMorningWhatsappSummary(body);
}
