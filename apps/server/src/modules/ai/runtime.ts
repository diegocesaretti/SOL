import { config } from "../../config.js";
import type { AiProvider, ReasoningRequest, ReasoningResult } from "./provider.js";
import { codexProvider } from "./codex/runtime.js";
import { OpenAiProvider } from "./openai/provider.js";

export type AiProviderMode = "auto" | "openai" | "codex";

export const openAiProvider = new OpenAiProvider({
  apiKey: config.openaiApiKey,
  baseUrl: config.openaiBaseUrl,
  model: config.openaiModel,
  fastModel: config.openaiFastModel,
  timeoutMs: config.openaiRequestTimeoutMs,
  maxOutputTokens: config.openaiMaxOutputTokens,
});

export class AiRouter implements AiProvider {
  readonly id = "router";

  constructor(
    private readonly mode: AiProviderMode,
    private readonly openai: AiProvider,
    private readonly codex: AiProvider,
  ) {}

  private providers(): AiProvider[] {
    if (this.mode === "openai") return [this.openai];
    if (this.mode === "codex") return [this.codex];
    return [this.openai, this.codex];
  }

  async isAvailable(): Promise<boolean> {
    for (const provider of this.providers()) {
      if (await provider.isAvailable()) return true;
    }
    return false;
  }

  async reason(request: ReasoningRequest): Promise<ReasoningResult> {
    const failures: string[] = [];
    for (const provider of this.providers()) {
      if (!(await provider.isAvailable())) continue;
      try {
        return await provider.reason(request);
      } catch (error) {
        failures.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`);
        if (this.mode !== "auto") throw error;
      }
    }
    if (failures.length) throw new Error(`No AI provider completed the request (${failures.join("; ")})`);
    throw new Error(`No AI provider is available for mode ${this.mode}`);
  }

  async status(): Promise<{
    mode: AiProviderMode;
    activeProvider?: string;
    providers: Array<{ id: string; configured: boolean; available: boolean }>;
  }> {
    const openaiAvailable = await this.openai.isAvailable();
    const codexAvailable = await this.codex.isAvailable();
    const availableById = new Map<string, boolean>([
      [this.openai.id, openaiAvailable],
      [this.codex.id, codexAvailable],
    ]);
    const activeProvider = this.providers().find((provider) => availableById.get(provider.id))?.id;
    return {
      mode: this.mode,
      activeProvider,
      providers: [
        { id: "openai", configured: Boolean(config.openaiApiKey), available: openaiAvailable },
        { id: "codex", configured: true, available: codexAvailable },
      ],
    };
  }
}

export const aiProvider = new AiRouter(config.aiProvider, openAiProvider, codexProvider);
