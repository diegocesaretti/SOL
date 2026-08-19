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

const TRIVIAL = /^(?:ok|okay|dale|bueno|bien|si|sí|no|aja|ajá|jaja+|jeje+|gracias|genial|perfecto|listo|👍|👌|❤️|😂|🤣|🙏)[.!?\s]*$/iu;
const ONLY_SYMBOLS = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{P}\p{S}\s]+$/u;

const DATE = /\b(?:hoy|mañana|manana|pasado mañana|pasado manana|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|\d{1,2}[\/.\-]\d{1,2}(?:[\/.\-]\d{2,4})?)\b/iu;
const TIME = /\b(?:a\s+las\s+\d{1,2}(?::\d{2})?|\d{1,2}:\d{2}|\d{1,2}\s*(?:am|pm|hs|hrs|horas))\b/iu;
const FUTURE = /\b(?:después|despues|más tarde|mas tarde|esta tarde|esta noche|la semana que viene|próxima semana|proxima semana|el finde|fin de semana)\b/iu;
const COMMITMENT = /\b(?:voy|vamos|vengo|viene|venimos|paso|pasamos|llevo|llevamos|traigo|traemos|te llamo|te mando|te envío|te envio|nos vemos|quedamos|confirmo|reservo|retiro|busco|pasá|pasa|vení|veni)\b/iu;
const TASK = /\b(?:recordame|recuérdame|recuerdame|acordate|no te olvides|hay que|tenemos que|tengo que|debo|tenés que|tenes que|mandar|enviar|comprar|pagar|buscar|llevar|llamar|hacer|presentar|entregar)\b/iu;
const DEADLINE = /\b(?:vence|vencimiento|fecha límite|fecha limite|antes de|hasta el|último día|ultimo dia|cuota|factura)\b/iu;
const EVENT = /\b(?:turno|cita|reunión|reunion|cumple|cumpleaños|cumpleanos|dentista|médico|medico|técnico|tecnico|partido|fútbol|futbol|clase|colegio|escuela|visita|viaje|vuelo)\b/iu;

/**
 * Cheap local gate before any LLM work. It deliberately prefers false negatives
 * over sending the household's ordinary conversation traffic to Codex.
 */
export function scoreWhatsappCandidate(input: string | undefined): CandidateSignal {
  const value = input?.trim();
  if (!value || value.length < 4 || TRIVIAL.test(value) || ONLY_SYMBOLS.test(value)) {
    return { candidate: false, score: 0, reasons: [] };
  }

  let score = 0;
  const reasons: string[] = [];
  const add = (reason: string, points: number, matches: boolean) => {
    if (!matches) return;
    reasons.push(reason);
    score += points;
  };

  add("date", 0.3, DATE.test(value));
  add("time", 0.25, TIME.test(value));
  add("future", 0.15, FUTURE.test(value));
  add("commitment", 0.35, COMMITMENT.test(value));
  add("task", 0.35, TASK.test(value));
  add("deadline", 0.4, DEADLINE.test(value));
  add("event", 0.35, EVENT.test(value));

  // A single weak temporal word is not enough. Two independent signals normally are.
  score = Math.min(1, Math.round(score * 100) / 100);
  return { candidate: score >= 0.5, score, reasons };
}
