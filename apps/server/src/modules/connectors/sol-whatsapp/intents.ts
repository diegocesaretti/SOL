export type AssistantIntent =
  | { kind: "help" }
  | { kind: "today" }
  | { kind: "tomorrow" }
  | { kind: "pending" }
  | { kind: "yes" }
  | { kind: "no" }
  | { kind: "approve"; reference: string }
  | { kind: "reject"; reference: string }
  | { kind: "create" }
  | { kind: "question" };

function normalized(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function parseAssistantIntent(text: string): AssistantIntent {
  const value = normalized(text).replace(/[.!?]+$/g, "").trim();

  const approve = value.match(/^(?:aprobar|aceptar|confirmar)\s+([0-9a-f]{4,12})$/i);
  if (approve?.[1]) return { kind: "approve", reference: approve[1] };
  const reject = value.match(/^(?:rechazar|ignorar|descartar)\s+([0-9a-f]{4,12})$/i);
  if (reject?.[1]) return { kind: "reject", reference: reject[1] };

  if (/^(?:si|s|dale|ok|okay|confirmo|hacelo|hazlo)$/.test(value)) return { kind: "yes" };
  if (/^(?:no|n|rechazo|ignorar|dejalo|dejalo asi|cancelar)$/.test(value)) return { kind: "no" };

  // Read-only agenda/list intents are deliberately checked before write-proposal intents.
  if (/\b(?:pendientes|propuestas|por aprobar|por revisar)\b/.test(value)) return { kind: "pending" };
  if (/\bmanana\b/.test(value) && /\b(?:que tengo|agenda|planes|eventos|dia|brief|resumen)\b/.test(value)) {
    return { kind: "tomorrow" };
  }
  if (/\bhoy\b/.test(value) && /\b(?:que tengo|agenda|planes|eventos|dia|brief|resumen)\b/.test(value)) {
    return { kind: "today" };
  }

  // Creating something requires a verb-like request; the noun "agenda" alone is not a write command.
  if (/\b(?:recordame|recuerdame|agendame|anota|anotame|crea|crear|sumame|agrega|agregame|avisa|avisame)\b/.test(value)) {
    return { kind: "create" };
  }

  if (/^(?:hola|buenas|ayuda|help|que podes hacer|que puedes hacer|menu)$/.test(value)) {
    return { kind: "help" };
  }
  return { kind: "question" };
}
