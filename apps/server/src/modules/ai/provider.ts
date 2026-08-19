export interface ReasoningRequest {
  householdId: string;
  memberId: string;
  purpose: "conversation" | "classification" | "consolidation" | "planning" | "automation";
  instructions: string;
  context: unknown;
}

export interface ReasoningResult {
  text: string;
  provider: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

/**
 * SOL depends on this contract, never directly on Codex/OpenAI.
 * A Codex OAuth/App Server adapter can implement it without changing the domain.
 */
export interface AiProvider {
  readonly id: string;
  isAvailable(): Promise<boolean>;
  reason(request: ReasoningRequest): Promise<ReasoningResult>;
}
