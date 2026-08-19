import { createHash, randomBytes } from "node:crypto";
import {
  extractMessageContent,
  normalizeMessageContent,
  type WAMessage,
} from "baileys";
import type { DomainEvent, EventBus } from "../../../core/event-bus.js";
import { db } from "../../../database/client.js";
import { codexProvider } from "../../ai/codex/runtime.js";
import { buildExecutiveBrief, type ExecutiveBriefContent } from "../../executive/briefs.js";
import {
  approveExecutiveProposal,
  listExecutiveProposals,
  rejectExecutiveProposal,
  type ExecutiveProposal,
} from "../../executive/proposals.js";
import { extractWhatsappText } from "../whatsapp/message-content.js";
import { parseAssistantIntent } from "./intents.js";
import {
  activeBindingForMember,
  getLastProposal,
  getMemberContext,
  getSolWhatsappAccount,
  listActiveManagerBindings,
  recordSolWhatsappInteraction,
  refreshBindingJids,
  resolveBindingByJids,
  saveBindingChallenge,
  setLastProposal,
  verifyBindingChallenge,
  type SolWhatsappBinding,
} from "./repository.js";

export interface SolWhatsappTransport {
  sendText(sourceAccountId: string, jid: string, text: string): Promise<void>;
  isOpen(sourceAccountId: string): boolean;
}

export interface SolWhatsappInbound {
  sourceAccountId: string;
  householdId: string;
  message: WAMessage;
  reply(text: string): Promise<void>;
}

function verificationHash(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

export async function startSolWhatsappBinding(
  sourceAccountId: string,
  memberId: string,
): Promise<{ code: string; expiresAt: string }> {
  const code = `SOL-${randomBytes(4).toString("hex").toUpperCase()}`;
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  await saveBindingChallenge({
    sourceAccountId,
    memberId,
    verificationHash: verificationHash(code),
    expiresAt,
  });
  return { code, expiresAt: expiresAt.toISOString() };
}

function senderJids(message: WAMessage): { primary?: string; alternate?: string; all: string[] } {
  const key = message.key as WAMessage["key"] & {
    remoteJidAlt?: string;
    participantAlt?: string;
  };
  const values = [
    key.remoteJid ?? undefined,
    key.remoteJidAlt,
    key.participant ?? undefined,
    key.participantAlt,
    message.participant ?? undefined,
  ].filter((item): item is string => Boolean(item));
  const direct = values.filter(
    (jid) => !jid.endsWith("@g.us") && !jid.endsWith("@broadcast") && !jid.endsWith("@newsletter"),
  );
  return {
    primary: key.remoteJid ?? undefined,
    alternate: key.remoteJidAlt ?? key.participantAlt,
    all: [...new Set(direct)],
  };
}

function messageText(message: WAMessage): string | undefined {
  if (!message.message) return undefined;
  const normalizedContent = normalizeMessageContent(message.message);
  const content = extractMessageContent(normalizedContent) ?? normalizedContent;
  return extractWhatsappText(content);
}

function shortRef(proposalId: string): string {
  return proposalId.slice(0, 8).toUpperCase();
}

function formatWhen(value: string | undefined, timezone: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: timezone,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function proposalText(proposal: ExecutiveProposal, timezone: string): string {
  const when = formatWhen(proposal.startsAt ?? proposal.dueAt, timezone);
  return [
    `Detecté: ${proposal.title}`,
    when ? `Cuándo: ${when}` : undefined,
    proposal.summary && proposal.summary !== proposal.title ? proposal.summary : undefined,
    `Ref: ${shortRef(proposal.id)}`,
    "¿Lo apruebo? Respondé sí/no, o usá aprobar/rechazar + la referencia.",
  ].filter(Boolean).join("\n");
}

function formatBrief(brief: ExecutiveBriefContent, timezone: string): string {
  const heading = brief.type === "morning" ? "Tu día de hoy" : "Tu día de mañana";
  const lines = [`*${heading}*`, brief.summary];
  if (brief.events.length) {
    lines.push("", "Agenda:");
    for (const event of brief.events.slice(0, 8)) {
      const start = event.start?.dateTime ?? event.start?.date;
      const when = start ? formatWhen(start, timezone) : undefined;
      lines.push(`• ${when ? `${when} · ` : ""}${event.title}`);
    }
  }
  if (brief.tasks.length) {
    lines.push("", "Pendientes:");
    for (const task of brief.tasks.slice(0, 8)) lines.push(`• ${task.title}`);
  }
  if (brief.pendingProposals.length) {
    lines.push("", `Propuestas por revisar: ${brief.pendingProposals.length}`);
  }
  if (brief.conflicts.length) {
    lines.push("", `⚠️ Conflictos de agenda: ${brief.conflicts.length}`);
  }
  return lines.join("\n").slice(0, 7000);
}

async function writeOutboundAudit(input: {
  sourceAccountId: string;
  memberId: string;
  jid: string;
  text: string;
  intent: string;
  actorMemberId?: string;
  approvalState?: string;
}): Promise<void> {
  await recordSolWhatsappInteraction({
    sourceAccountId: input.sourceAccountId,
    memberId: input.memberId,
    direction: "outbound",
    jid: input.jid,
    bodyText: input.text,
    intent: input.intent,
  });
  const member = await getMemberContext(input.memberId);
  if (!member) return;
  await db.query(
    `INSERT INTO action_log(
       household_id, actor_member_id, action_type, target_provider, target_ref,
       approval_state, request, result, completed_at
     ) VALUES ($1, $2, 'whatsapp.assistant.send', 'whatsapp', $3, $4, $5::jsonb, $6::jsonb, now())`,
    [
      member.householdId,
      input.actorMemberId ?? null,
      input.jid,
      input.approvalState ?? "not_required",
      JSON.stringify({ sourceAccountId: input.sourceAccountId, intent: input.intent }),
      JSON.stringify({ delivered: true, chars: input.text.length }),
    ],
  );
}

async function writeOutboundAuditSafely(input: Parameters<typeof writeOutboundAudit>[0]): Promise<void> {
  try {
    await writeOutboundAudit(input);
  } catch (error) {
    // The remote WhatsApp send already succeeded. Do not turn a local audit failure
    // into an outbound-message retry that could duplicate the user's notification.
    console.error("[sol-whatsapp] outbound audit failed after successful send", error);
  }
}

async function sendToBinding(
  transport: SolWhatsappTransport,
  binding: SolWhatsappBinding,
  text: string,
  intent: string,
  actorMemberId?: string,
  approvalState?: string,
): Promise<void> {
  const jid = binding.primaryJid ?? binding.alternateJid;
  if (!jid) throw new Error("sol_whatsapp_binding_has_no_jid");
  await transport.sendText(binding.sourceAccountId, jid, text);
  await writeOutboundAuditSafely({
    sourceAccountId: binding.sourceAccountId,
    memberId: binding.memberId,
    jid,
    text,
    intent,
    actorMemberId,
    approvalState,
  });
}

async function sendReply(
  inbound: SolWhatsappInbound,
  binding: SolWhatsappBinding,
  text: string,
  intent: string,
): Promise<void> {
  const jid = senderJids(inbound.message).primary ?? binding.primaryJid ?? "unknown";
  await inbound.reply(text);
  await writeOutboundAuditSafely({
    sourceAccountId: inbound.sourceAccountId,
    memberId: binding.memberId,
    jid,
    text,
    intent,
    actorMemberId: binding.memberId,
  });
}

async function pendingByReference(binding: SolWhatsappBinding, reference: string): Promise<ExecutiveProposal | null> {
  const member = await getMemberContext(binding.memberId);
  if (!member) return null;
  const proposals = await listExecutiveProposals({
    householdId: member.householdId,
    memberId: member.memberId,
    status: "pending",
  });
  const ref = reference.toLowerCase();
  const matches = proposals.filter((proposal) => proposal.id.toLowerCase().startsWith(ref));
  return matches.length === 1 ? matches[0]! : null;
}

async function decideProposal(
  binding: SolWhatsappBinding,
  proposal: ExecutiveProposal,
  approve: boolean,
): Promise<string> {
  const member = await getMemberContext(binding.memberId);
  if (!member) return "No pude validar tu identidad en SOL.";
  try {
    if (!approve) {
      await rejectExecutiveProposal({
        proposalId: proposal.id,
        householdId: member.householdId,
        memberId: member.memberId,
        role: member.role,
      });
      await setLastProposal(binding.sourceAccountId, binding.memberId, null);
      return `Listo. Rechacé “${proposal.title}”.`;
    }
    const result = await approveExecutiveProposal({
      proposalId: proposal.id,
      householdId: member.householdId,
      memberId: member.memberId,
      role: member.role,
    });
    await setLastProposal(binding.sourceAccountId, binding.memberId, null);
    return result.kind === "calendar_event"
      ? `Listo. Agregué “${proposal.title}” al calendario.`
      : `Listo. Creé la tarea “${proposal.title}”.`;
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (code === "calendar_target_required") {
      return "Puedo aprobarlo, pero primero necesitás elegir un calendario de escritura en SOL.";
    }
    if (code === "event_time_required") {
      return "Ese evento todavía no tiene una hora suficientemente clara. Editalo en SOL antes de aprobarlo.";
    }
    if (code === "proposal_not_found_or_not_approvable") {
      return "Esa propuesta ya no está pendiente o tu rol no puede aprobarla.";
    }
    return `No pude completar la aprobación: ${code}`;
  }
}

async function parseCommandProposal(binding: SolWhatsappBinding, text: string): Promise<ExecutiveProposal | null> {
  const member = await getMemberContext(binding.memberId);
  if (!member || !(await codexProvider.isAvailable())) return null;
  const result = await codexProvider.reason({
    householdId: member.householdId,
    memberId: member.memberId,
    purpose: "planning",
    instructions: [
      "Interpret this authenticated SOL member command as at most one proposed task/event/commitment/deadline.",
      "Do not execute anything. Return only JSON.",
      "Infer relative dates using currentTime and timezone, but never invent a clock time that was not stated.",
      'Schema: {"kind":"task|event|commitment|deadline|none","title":"short","summary":"brief","dateTime":null,"dueAt":null}',
    ].join("\n"),
    context: {
      command: text,
      currentTime: new Date().toISOString(),
      timezone: member.timezone,
      member: member.displayName,
      household: member.householdName,
    },
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""));
  } catch {
    return null;
  }
  const kind = typeof parsed.kind === "string" ? parsed.kind : "none";
  if (!["task", "event", "commitment", "deadline"].includes(kind)) return null;
  const title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim().slice(0, 240) : null;
  if (!title) return null;
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 2000) : null;
  const parseDate = (value: unknown): Date | null => {
    if (typeof value !== "string" || !value.trim()) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const startsAt = parseDate(parsed.dateTime);
  const dueAt = parseDate(parsed.dueAt);
  if ((kind === "event" || kind === "commitment") && !startsAt) return null;

  const inserted = await db.query<{ id: string }>(
    `INSERT INTO executive_proposals(
       household_id, owner_member_id, kind, status, title, summary,
       starts_at, due_at, visibility, confidence, payload
     ) VALUES ($1, $2, $3::executive_proposal_kind, 'pending', $4, $5, $6, $7,
               'private', 1, $8::jsonb)
     RETURNING id`,
    [
      member.householdId,
      member.memberId,
      kind,
      title,
      summary,
      startsAt,
      dueAt,
      JSON.stringify({
        origin: "sol_whatsapp_command",
        originalCommand: text.slice(0, 2000),
      }),
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) return null;
  const proposals = await listExecutiveProposals({
    householdId: member.householdId,
    memberId: member.memberId,
    status: "pending",
  });
  return proposals.find((proposal) => proposal.id === id) ?? null;
}

async function answerQuestion(binding: SolWhatsappBinding, text: string): Promise<string> {
  const member = await getMemberContext(binding.memberId);
  if (!member) return "No pude cargar tu perfil de SOL.";
  const [today, tomorrow] = await Promise.all([
    buildExecutiveBrief(member.memberId, "morning", { persist: false }),
    buildExecutiveBrief(member.memberId, "tomorrow_preview", { persist: false }),
  ]);
  if (!(await codexProvider.isAvailable())) {
    return `Codex no está conectado ahora. Hoy: ${today.summary}`;
  }
  const result = await codexProvider.reason({
    householdId: member.householdId,
    memberId: member.memberId,
    purpose: "conversation",
    instructions: [
      "Answer the authenticated SOL member in concise natural Rioplatense Spanish.",
      "Use only the authorized context supplied here. Do not invent facts.",
      "Do not execute actions and do not claim an action happened unless the context says it did.",
      "If the request requires a source SOL does not yet have, say so plainly.",
    ].join("\n"),
    context: {
      question: text,
      member: member.displayName,
      household: member.householdName,
      timezone: member.timezone,
      today,
      tomorrow,
    },
  });
  return result.text.trim().slice(0, 7000) || "No encontré una respuesta útil con el contexto disponible.";
}

export async function handleSolWhatsappInbound(inbound: SolWhatsappInbound): Promise<void> {
  if (inbound.message.key.fromMe) return;
  const remoteJid = inbound.message.key.remoteJid ?? undefined;
  if (!remoteJid || remoteJid.endsWith("@g.us") || remoteJid.endsWith("@broadcast")) return;
  const text = messageText(inbound.message)?.trim();
  if (!text) return;
  const jids = senderJids(inbound.message);
  if (!jids.primary) return;

  const codeMatch = text.toUpperCase().match(/^SOL-[0-9A-F]{8}$/);
  if (codeMatch) {
    const binding = await verifyBindingChallenge({
      sourceAccountId: inbound.sourceAccountId,
      verificationHash: verificationHash(codeMatch[0]),
      primaryJid: jids.primary,
      alternateJid: jids.alternate,
    });
    if (!binding) {
      await inbound.reply("Ese código no es válido, venció o este WhatsApp ya está vinculado a otro perfil de SOL. Generá uno nuevo o revocá el vínculo anterior.");
      return;
    }
    await recordSolWhatsappInteraction({
      sourceAccountId: inbound.sourceAccountId,
      memberId: binding.memberId,
      direction: "inbound",
      jid: jids.primary,
      bodyText: text,
      intent: "binding",
    });
    await sendReply(
      inbound,
      binding,
      `Listo, ${binding.displayName}. Este WhatsApp quedó vinculado a tu perfil de SOL. Podés preguntarme “¿qué tengo hoy?”, “pendientes” o pedirme “recordame …”.`,
      "binding_confirmed",
    );
    return;
  }

  const binding = await resolveBindingByJids(inbound.sourceAccountId, jids.all);
  if (!binding) {
    await inbound.reply("Este WhatsApp todavía no está vinculado a un miembro de SOL. Iniciá sesión en SOL → WhatsApp de SOL → Vincular mi WhatsApp.");
    return;
  }
  await refreshBindingJids(
    inbound.sourceAccountId,
    binding.memberId,
    jids.primary,
    jids.alternate,
  );
  const intent = parseAssistantIntent(text);
  await recordSolWhatsappInteraction({
    sourceAccountId: inbound.sourceAccountId,
    memberId: binding.memberId,
    direction: "inbound",
    jid: jids.primary,
    bodyText: text,
    intent: intent.kind,
  });

  if (intent.kind === "help") {
    await sendReply(
      inbound,
      binding,
      "Podés preguntarme por hoy o mañana, pedir “pendientes”, crear algo con “recordame…”/“agendame…”, o aprobar la última propuesta con sí/no. Las acciones siguen respetando tus permisos en SOL.",
      "help",
    );
    return;
  }

  if (intent.kind === "today" || intent.kind === "tomorrow") {
    const member = await getMemberContext(binding.memberId);
    if (!member) return;
    const brief = await buildExecutiveBrief(
      member.memberId,
      intent.kind === "today" ? "morning" : "tomorrow_preview",
      { persist: false },
    );
    await sendReply(inbound, binding, formatBrief(brief, member.timezone), intent.kind);
    return;
  }

  if (intent.kind === "pending") {
    const member = await getMemberContext(binding.memberId);
    if (!member) return;
    const proposals = await listExecutiveProposals({
      householdId: member.householdId,
      memberId: member.memberId,
      status: "pending",
    });
    if (!proposals.length) {
      await sendReply(inbound, binding, "No tenés propuestas pendientes.", "pending");
      return;
    }
    const textOut = [
      "*Propuestas pendientes*",
      ...proposals.slice(0, 8).map((proposal) => `• ${shortRef(proposal.id)} · ${proposal.title}`),
      "",
      "Usá aprobar/rechazar + referencia.",
    ].join("\n");
    await sendReply(inbound, binding, textOut, "pending");
    return;
  }

  if (intent.kind === "approve" || intent.kind === "reject") {
    const proposal = await pendingByReference(binding, intent.reference);
    const result = proposal
      ? await decideProposal(binding, proposal, intent.kind === "approve")
      : "No encontré una única propuesta pendiente con esa referencia.";
    await sendReply(inbound, binding, result, intent.kind);
    return;
  }

  if (intent.kind === "yes" || intent.kind === "no") {
    const proposalId = await getLastProposal(binding.sourceAccountId, binding.memberId);
    const member = await getMemberContext(binding.memberId);
    const proposals = member
      ? await listExecutiveProposals({
          householdId: member.householdId,
          memberId: member.memberId,
          status: "pending",
        })
      : [];
    const proposal = proposals.find((item) => item.id === proposalId);
    const result = proposal
      ? await decideProposal(binding, proposal, intent.kind === "yes")
      : "No tengo una propuesta reciente esperando un sí/no. Pedime “pendientes” para ver las disponibles.";
    await sendReply(inbound, binding, result, intent.kind);
    return;
  }

  if (intent.kind === "create") {
    const member = await getMemberContext(binding.memberId);
    const proposal = await parseCommandProposal(binding, text);
    if (!proposal || !member) {
      await sendReply(
        inbound,
        binding,
        "Entendí que querés crear algo, pero me falta una fecha/hora clara o Codex no pudo estructurarlo. Decímelo con un poco más de detalle.",
        "create_needs_detail",
      );
      return;
    }
    await setLastProposal(binding.sourceAccountId, binding.memberId, proposal.id);
    await sendReply(inbound, binding, proposalText(proposal, member.timezone), "create_proposal");
    return;
  }

  await sendReply(inbound, binding, await answerQuestion(binding, text), "question");
}

async function deliveryClaim(input: {
  sourceAccountId: string;
  memberId: string;
  eventType: string;
  aggregateId: string;
}): Promise<boolean> {
  const result = await db.query<{ status: string }>(
    `INSERT INTO sol_whatsapp_deliveries(
       source_account_id, member_id, event_type, aggregate_id, status, attempts, updated_at
     ) VALUES ($1, $2, $3, $4, 'pending', 1, now())
     ON CONFLICT(source_account_id, member_id, event_type, aggregate_id)
     DO UPDATE SET attempts = sol_whatsapp_deliveries.attempts + 1,
                   status = CASE WHEN sol_whatsapp_deliveries.status = 'sent' THEN 'sent' ELSE 'pending' END,
                   updated_at = now()
     RETURNING status`,
    [input.sourceAccountId, input.memberId, input.eventType, input.aggregateId],
  );
  return result.rows[0]?.status !== "sent";
}

async function deliverySuccess(input: {
  sourceAccountId: string;
  memberId: string;
  eventType: string;
  aggregateId: string;
}): Promise<void> {
  await db.query(
    `UPDATE sol_whatsapp_deliveries
     SET status = 'sent', sent_at = now(), last_error = NULL, updated_at = now()
     WHERE source_account_id = $1 AND member_id = $2 AND event_type = $3 AND aggregate_id = $4`,
    [input.sourceAccountId, input.memberId, input.eventType, input.aggregateId],
  );
}

async function deliveryFailure(input: {
  sourceAccountId: string;
  memberId: string;
  eventType: string;
  aggregateId: string;
  error: unknown;
}): Promise<void> {
  await db.query(
    `UPDATE sol_whatsapp_deliveries
     SET status = 'failed', last_error = $5, updated_at = now()
     WHERE source_account_id = $1 AND member_id = $2 AND event_type = $3 AND aggregate_id = $4`,
    [
      input.sourceAccountId,
      input.memberId,
      input.eventType,
      input.aggregateId,
      input.error instanceof Error ? input.error.message.slice(0, 2000) : String(input.error).slice(0, 2000),
    ],
  );
}

async function deliverProposalEvent(
  event: DomainEvent<{ proposalId?: string }>,
  transport: SolWhatsappTransport,
): Promise<void> {
  const proposalId = event.payload.proposalId;
  if (!proposalId) return;
  const result = await db.query<{
    id: string;
    household_id: string;
    owner_member_id: string | null;
    kind: ExecutiveProposal["kind"];
    status: ExecutiveProposal["status"];
    title: string;
    summary: string | null;
    starts_at: Date | null;
    due_at: Date | null;
    confidence: number;
    payload: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT id, household_id, owner_member_id, kind::text, status::text, title, summary,
            starts_at, due_at, confidence, payload, created_at
     FROM executive_proposals WHERE id = $1`,
    [proposalId],
  );
  const row = result.rows[0];
  if (!row || row.status !== "pending" || row.payload?.origin === "sol_whatsapp_command") return;
  const account = await getSolWhatsappAccount(row.household_id);
  if (!account || !transport.isOpen(account.id)) return;
  const proposal: ExecutiveProposal = {
    id: row.id,
    householdId: row.household_id,
    ownerMemberId: row.owner_member_id ?? undefined,
    kind: row.kind,
    status: row.status,
    title: row.title,
    summary: row.summary ?? undefined,
    startsAt: row.starts_at?.toISOString(),
    dueAt: row.due_at?.toISOString(),
    confidence: Number(row.confidence),
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
  };
  const recipients = row.owner_member_id
    ? [await activeBindingForMember(account.id, row.owner_member_id)].filter(
        (item): item is SolWhatsappBinding => Boolean(item),
      )
    : await listActiveManagerBindings(account.id);

  for (const binding of recipients) {
    const key = {
      sourceAccountId: account.id,
      memberId: binding.memberId,
      eventType: event.type,
      aggregateId: row.id,
    };
    if (!(await deliveryClaim(key))) continue;
    try {
      const member = await getMemberContext(binding.memberId);
      if (!member) continue;
      await sendToBinding(
        transport,
        binding,
        proposalText(proposal, member.timezone),
        "proposal_delivery",
      );
      await setLastProposal(account.id, binding.memberId, proposal.id);
      await deliverySuccess(key);
    } catch (error) {
      await deliveryFailure({ ...key, error });
      throw error;
    }
  }
}

async function deliverBriefEvent(
  event: DomainEvent<{ briefId?: string; memberId?: string }>,
  transport: SolWhatsappTransport,
): Promise<void> {
  const briefId = event.payload.briefId;
  const memberId = event.payload.memberId;
  if (!briefId || !memberId) return;
  const result = await db.query<{
    household_id: string;
    member_id: string;
    content: ExecutiveBriefContent;
  }>(
    `SELECT household_id, member_id, content FROM executive_briefs WHERE id = $1`,
    [briefId],
  );
  const row = result.rows[0];
  if (!row) return;
  const account = await getSolWhatsappAccount(row.household_id);
  if (!account || !transport.isOpen(account.id)) return;
  const binding = await activeBindingForMember(account.id, row.member_id);
  if (!binding) return;
  const member = await getMemberContext(binding.memberId);
  if (!member) return;
  const key = {
    sourceAccountId: account.id,
    memberId: binding.memberId,
    eventType: event.type,
    aggregateId: briefId,
  };
  if (!(await deliveryClaim(key))) return;
  try {
    await sendToBinding(transport, binding, formatBrief(row.content, member.timezone), "brief_delivery");
    await deliverySuccess(key);
  } catch (error) {
    await deliveryFailure({ ...key, error });
    throw error;
  }
}

export function registerSolWhatsappDelivery(
  eventBus: EventBus,
  transport: SolWhatsappTransport,
): () => void {
  const unregisterProposal = eventBus.subscribe<{ proposalId?: string }>(
    "executive.proposal.created",
    (event) => deliverProposalEvent(event, transport),
  );
  const unregisterBrief = eventBus.subscribe<{ briefId?: string; memberId?: string }>(
    "executive.brief.created",
    (event) => deliverBriefEvent(event, transport),
  );
  return () => {
    unregisterProposal();
    unregisterBrief();
  };
}
