import type { AuthPrincipal } from "../auth/session.js";
import {
  rememberMemoryFact,
  type MemoryEntityKind,
  type MemoryVisibility,
} from "../memory/service.js";

// Compatibility facade for the existing Nexo MCP surface. The durable memory
// implementation now belongs to SOL.Memory rather than to the Nexo/MCP module.
export type NexoMemoryEntityKind = Exclude<MemoryEntityKind, "device">;

export interface NexoMemoryFactInput {
  entityKind: NexoMemoryEntityKind;
  entityName: string;
  predicate: string;
  value: unknown;
  visibility?: MemoryVisibility;
  replaceExisting?: boolean;
  evidenceSourceItemIds?: string[];
}

export async function rememberMcpFact(
  principal: AuthPrincipal,
  input: NexoMemoryFactInput,
): Promise<Record<string, unknown>> {
  return rememberMemoryFact(principal, {
    ...input,
    source: {
      channel: "nexo",
      label: `Nexo · ${principal.displayName}`,
    },
  });
}
