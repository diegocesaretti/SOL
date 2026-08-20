export type IntelligenceRoute = "operational" | "knowledge";
export type IntelligencePriority = "none" | "normal" | "high";

export interface IntelligenceGateInput {
  provider: string;
  title?: string | null;
  bodyText?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface IntelligenceGateDecision {
  candidate: boolean;
  score: number;
  operationalScore: number;
  knowledgeScore: number;
  priority: IntelligencePriority;
  routes: IntelligenceRoute[];
  reasons: string[];
}

const TRIVIAL = /^(?:ok|okay|dale|bueno|bien|si|sí|no|aja|ajá|jaja+|jeje+|gracias|genial|perfecto|listo|👍|👌|❤️|😂|🤣|🙏)[.!?\s]*$/iu;
const ONLY_SYMBOLS = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{P}\p{S}\s]+$/u;
const DATE = /\b(?:hoy|mañana|manana|pasado mañana|pasado manana|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|\d{1,2}[\/.\-]\d{1,2}(?:[\/.\-]\d{2,4})?)\b/iu;
const DAY_OF_MONTH = /\b(?:el|día|dia)\s+(?:[12]?\d|3[01])\b/iu;
const TIME = /\b(?:a\s+las\s+\d{1,2}(?::\d{2})?|\d{1,2}:\d{2}|\d{1,2}\s*(?:am|pm|hs|hrs|horas))\b/iu;
const FUTURE = /\b(?:después|despues|más tarde|mas tarde|esta tarde|esta noche|la semana que viene|próxima semana|proxima semana|el finde|fin de semana)\b/iu;
const COMMITMENT = /\b(?:voy|vamos|vengo|viene|venimos|paso|pasamos|llevo|llevamos|traigo|traemos|te llamo|te mando|te envío|te envio|nos vemos|quedamos|confirmo|reservo|retiro|busco|pasá|pasa|vení|veni)\b/iu;
const TASK = /\b(?:recordame|recuérdame|recuerdame|acordate|no te olvides|hay que|tenemos que|tengo que|debo|tenés que|tenes que|mandar|enviar|comprar|pagar|buscar|llevar|llamar|hacer|presentar|entregar)\b/iu;
const DEADLINE = /\b(?:vence|vencimiento|fecha límite|fecha limite|antes de|hasta el|último día|ultimo dia|cuota|factura)\b/iu;
const EVENT = /\b(?:turno|cita|reunión|reunion|cumple|cumpleaños|cumpleanos|dentista|médico|medico|técnico|tecnico|partido|fútbol|futbol|clase|colegio|escuela|visita|viaje|vuelo|reserva|hotel)\b/iu;
const MONEY = /(?:\$|usd|u\$s|ars|eur|€)\s?\d|\b\d[\d.,]*\s?(?:pesos|dólares|dolares|usd|ars|eur)\b/iu;

const PREFERENCE = /\b(?:prefiero|preferimos|me gusta|nos gusta|no me gusta|odio|favorito|favorita|preferencia)\b/iu;
const ROUTINE = /\b(?:siempre|normalmente|habitualmente|todos los|todas las|cada día|cada dia|cada semana|cada mes|los lunes|los martes|los miércoles|los miercoles|los jueves|los viernes|los sábados|los sabados|los domingos)\b/iu;
const RELATIONSHIP = /\b(?:mi esposa|mi esposo|mi pareja|mi hijo|mi hija|mi mamá|mi mama|mi papá|mi papa|mi hermano|mi hermana|mi socio|mi cliente|mi proveedor|trabaja en|vive en|estudia en|es de)\b/iu;
const DURABLE = /\b(?:proyecto|empresa|negocio|trabajo|dirección|direccion|domicilio|teléfono|telefono|correo|email|cumpleaños|cumpleanos|modelo|equipo|vehículo|vehiculo|propiedad|contrato|membresía|membresia|suscripción|suscripcion)\b/iu;
const RECURRING = /\b(?:semanal|mensual|anual|diario|diaria|quincenal|recurrente|renovación|renovacion)\b/iu;

const NO_REPLY = /\b(?:no[-_.]?reply|noreply|do[-_.]?not[-_.]?reply)@/iu;
const BULK_TEXT = /\b(?:newsletter|boletín|boletin|promoción|promocion|oferta exclusiva|unsubscribe|darse de baja|cancelar suscripción|cancelar suscripcion)\b/iu;
const SECURITY_NOISE = /\b(?:código de verificación|codigo de verificacion|verification code|security alert|alerta de seguridad|nuevo inicio de sesión|nuevo inicio de sesion|sign-in attempt|one-time password|otp)\b/iu;

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function headerValue(metadata: Record<string, unknown> | null | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value : "";
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

function decision(operationalScore: number, knowledgeScore: number, reasons: string[]): IntelligenceGateDecision {
  const operational = clamp(operationalScore);
  const knowledge = clamp(knowledgeScore);
  const routes: IntelligenceRoute[] = [];
  if (operational >= 0.5) routes.push("operational");
  if (knowledge >= 0.5) routes.push("knowledge");
  const score = Math.max(operational, knowledge);
  return {
    candidate: routes.length > 0,
    score,
    operationalScore: operational,
    knowledgeScore: knowledge,
    priority: score >= 0.75 ? "high" : score >= 0.5 ? "normal" : "none",
    routes,
    reasons: [...new Set(reasons)],
  };
}

export function scoreIntelligenceCandidate(input: IntelligenceGateInput): IntelligenceGateDecision {
  const provider = input.provider.trim().toLowerCase();
  const title = input.title?.trim() ?? "";
  const body = input.bodyText?.trim() ?? "";
  const value = `${title}\n${body}`.trim();
  const reasons: string[] = [];

  if (!value || value.length < 4 || TRIVIAL.test(value) || ONLY_SYMBOLS.test(value)) {
    return decision(0, 0, []);
  }

  let operational = 0;
  let knowledge = 0;
  const addOperational = (reason: string, points: number, matches: boolean) => {
    if (!matches) return;
    operational += points;
    reasons.push(reason);
  };
  const addKnowledge = (reason: string, points: number, matches: boolean) => {
    if (!matches) return;
    knowledge += points;
    reasons.push(reason);
  };

  addOperational("date", 0.3, DATE.test(value));
  addOperational("day-of-month", 0.2, DAY_OF_MONTH.test(value));
  addOperational("time", 0.25, TIME.test(value));
  addOperational("future", 0.15, FUTURE.test(value));
  addOperational("commitment", 0.35, COMMITMENT.test(value));
  addOperational("task", 0.35, TASK.test(value));
  addOperational("deadline", 0.4, DEADLINE.test(value));
  addOperational("event", 0.35, EVENT.test(value));
  addOperational("money", 0.15, MONEY.test(value));

  addKnowledge("preference", 0.55, PREFERENCE.test(value));
  addKnowledge("routine", 0.55, ROUTINE.test(value));
  addKnowledge("relationship", 0.55, RELATIONSHIP.test(value));
  addKnowledge("durable-detail", 0.35, DURABLE.test(value));
  addKnowledge("recurring", 0.4, RECURRING.test(value));
  if (value.length >= 180) addKnowledge("substantial-text", 0.15, true);

  if (provider === "gmail") {
    const metadata = input.metadata ?? {};
    const labels = stringArray(metadata.labelIds).map((item) => item.toUpperCase());
    const from = `${headerValue(metadata, "from")} ${headerValue(metadata, "fromAddress")}`;
    const listUnsubscribe = headerValue(metadata, "listUnsubscribe");
    const precedence = headerValue(metadata, "precedence").toLowerCase();
    const autoSubmitted = headerValue(metadata, "autoSubmitted").toLowerCase();
    const hardNoise = labels.some((label) => label === "SPAM" || label === "TRASH");
    if (hardNoise) return decision(0, 0, ["gmail-spam-or-trash"]);

    const promotional = labels.includes("CATEGORY_PROMOTIONS") || BULK_TEXT.test(value);
    const bulk = Boolean(listUnsubscribe) || ["bulk", "list", "junk"].includes(precedence);
    const automated = NO_REPLY.test(from) || (autoSubmitted && autoSubmitted !== "no");
    const securityNoise = SECURITY_NOISE.test(value);
    const humanLike = !promotional && !bulk && !automated;

    if (labels.includes("IMPORTANT") || labels.includes("STARRED")) {
      operational += 0.15;
      knowledge += 0.15;
      reasons.push("gmail-important");
    }
    if (/^(?:re|fwd?|rv):/iu.test(title)) {
      knowledge += 0.2;
      reasons.push("gmail-thread-reply");
    }
    if (humanLike && body.length >= 40) {
      knowledge += 0.25;
      reasons.push("gmail-human-like");
    }
    if (promotional) {
      operational -= 0.45;
      knowledge -= 0.55;
      reasons.push("gmail-promotional");
    }
    if (bulk) {
      operational -= 0.35;
      knowledge -= 0.45;
      reasons.push("gmail-bulk");
    }
    if (automated) {
      knowledge -= 0.15;
      reasons.push("gmail-automated");
    }
    if (securityNoise) {
      operational -= 0.45;
      knowledge -= 0.45;
      reasons.push("gmail-security-noise");
    }
  } else if (provider !== "whatsapp") {
    // Preserve the previous consolidation behavior for structured/non-chat providers.
    // The stricter gate currently targets WhatsApp and Gmail only.
    if (body.length >= 20) {
      knowledge = Math.max(knowledge, 0.6);
      reasons.push("structured-source");
    }
  }

  return decision(operational, knowledge, reasons);
}
