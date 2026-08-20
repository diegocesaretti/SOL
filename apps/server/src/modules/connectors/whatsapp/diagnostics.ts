export type WhatsappDiagnosticLevel = "debug" | "info" | "warn" | "error";

export interface WhatsappDiagnosticEntry {
  id: number;
  at: string;
  level: WhatsappDiagnosticLevel;
  event: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface WhatsappRuntimeObservation {
  state: string;
  reconnectAttempt: number;
  updatedAt: string;
  lastError?: string;
}

const MAX_ENTRIES_PER_ACCOUNT = 250;
const buffers = new Map<string, WhatsappDiagnosticEntry[]>();
const runtimeSignatures = new Map<string, string>();
let nextId = 1;

function safeText(value: unknown, max = 1200): string {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

function safeDetails(details?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    // Never accept likely secret/payload fields into the diagnostic buffer.
    if (/token|secret|credential|auth|qr|message|payload|body/i.test(key)) continue;
    if (value == null || typeof value === "boolean" || typeof value === "number") {
      output[key] = value;
      continue;
    }
    if (typeof value === "string") {
      output[key] = safeText(value, 800);
      continue;
    }
    if (Array.isArray(value)) {
      output[key] = value.slice(0, 20).map((item) =>
        item == null || typeof item === "boolean" || typeof item === "number"
          ? item
          : safeText(item, 300),
      );
    }
  }
  return Object.keys(output).length ? output : undefined;
}

export function logWhatsappDiagnostic(
  sourceAccountId: string,
  level: WhatsappDiagnosticLevel,
  event: string,
  message: string,
  details?: Record<string, unknown>,
): WhatsappDiagnosticEntry {
  const entry: WhatsappDiagnosticEntry = {
    id: nextId++,
    at: new Date().toISOString(),
    level,
    event: safeText(event, 120),
    message: safeText(message),
    details: safeDetails(details),
  };
  const entries = buffers.get(sourceAccountId) ?? [];
  entries.push(entry);
  if (entries.length > MAX_ENTRIES_PER_ACCOUNT) {
    entries.splice(0, entries.length - MAX_ENTRIES_PER_ACCOUNT);
  }
  buffers.set(sourceAccountId, entries);
  return entry;
}

export function observeWhatsappRuntime(
  sourceAccountId: string,
  runtime: WhatsappRuntimeObservation,
): void {
  const signature = JSON.stringify({
    state: runtime.state,
    reconnectAttempt: runtime.reconnectAttempt,
    lastError: runtime.lastError ?? null,
  });
  if (runtimeSignatures.get(sourceAccountId) === signature) return;
  runtimeSignatures.set(sourceAccountId, signature);

  const level: WhatsappDiagnosticLevel =
    runtime.state === "error" || runtime.state === "logged_out"
      ? "error"
      : runtime.state === "reconnecting"
        ? "warn"
        : "info";
  logWhatsappDiagnostic(
    sourceAccountId,
    level,
    "runtime_state",
    runtime.lastError
      ? `${runtime.state}: ${runtime.lastError}`
      : `WhatsApp runtime changed to ${runtime.state}`,
    {
      state: runtime.state,
      reconnectAttempt: runtime.reconnectAttempt,
      runtimeUpdatedAt: runtime.updatedAt,
    },
  );
}

export function listWhatsappDiagnostics(
  sourceAccountId: string,
  limit = 200,
): WhatsappDiagnosticEntry[] {
  const bounded = Math.max(1, Math.min(250, Math.trunc(limit)));
  return (buffers.get(sourceAccountId) ?? []).slice(-bounded).reverse();
}

export function clearWhatsappDiagnostics(sourceAccountId: string): void {
  buffers.delete(sourceAccountId);
  runtimeSignatures.delete(sourceAccountId);
}
