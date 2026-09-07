import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const rootEnvPath = resolve(repoRoot, ".env");

try {
  loadEnvFile(rootEnvPath);
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") throw error;
}

function integerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function enumEnv<const T extends readonly string[]>(name: string, allowed: T, fallback: T[number]): T[number] {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T[number];
  throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
}

const codexHome = optionalEnv("SOL_CODEX_HOME") ?? resolve(repoRoot, ".sol", "codex");
const host = process.env.SOL_HOST ?? "127.0.0.1";
const port = integerEnv("SOL_PORT", 3000);

export const config = {
  repoRoot,
  host,
  port,
  logLevel: process.env.SOL_LOG_LEVEL ?? "info",
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgresql://sol:sol_dev_only@127.0.0.1:5432/sol",
  databasePoolMax: integerEnv("SOL_DB_POOL_MAX", 4),
  databaseIdleTimeoutMs: integerEnv("SOL_DB_IDLE_TIMEOUT_MS", 15_000),
  databaseConnectionTimeoutMs: integerEnv("SOL_DB_CONNECT_TIMEOUT_MS", 15_000),
  sessionDays: integerEnv("SOL_SESSION_DAYS", 30),
  cookieSecure: booleanEnv("SOL_COOKIE_SECURE", false),


  // Optional legacy AI enrichment. Nexo leaves this dormant by default and exposes
  // context/memory through MCP instead of running a competing assistant brain.
  aiProvider: enumEnv("SOL_AI_PROVIDER", ["auto", "openai", "codex"] as const, "auto"),
  openaiApiKey: optionalEnv("SOL_OPENAI_API_KEY") ?? optionalEnv("OPENAI_API_KEY"),
  openaiBaseUrl: optionalEnv("SOL_OPENAI_BASE_URL") ?? "https://api.openai.com/v1",
  openaiFastModel: optionalEnv("SOL_OPENAI_FAST_MODEL") ?? "gpt-5.4-nano",
  openaiModel: optionalEnv("SOL_OPENAI_MODEL") ?? "gpt-5.4-mini",
  openaiRequestTimeoutMs: integerEnv("SOL_OPENAI_REQUEST_TIMEOUT_MS", 45_000),
  openaiMaxOutputTokens: integerEnv("SOL_OPENAI_MAX_OUTPUT_TOKENS", 4_000),

  codexBin: process.env.SOL_CODEX_BIN?.trim() || "codex",
  codexHome,
  codexWorkingDirectory:
    optionalEnv("SOL_CODEX_CWD") ?? resolve(codexHome, "workspace"),
  codexRequestTimeoutMs: integerEnv("SOL_CODEX_REQUEST_TIMEOUT_MS", 30_000),
  outboxPollMs: integerEnv("SOL_OUTBOX_RECOVERY_MS", 30 * 60 * 1000),
  knowledgeConsolidationMs: integerEnv("SOL_KNOWLEDGE_CONSOLIDATION_MS", 6 * 60 * 60 * 1000),
  knowledgeBatchesPerRun: integerEnv("SOL_KNOWLEDGE_BATCHES_PER_RUN", 2),
  knowledgeBatchItems: integerEnv("SOL_KNOWLEDGE_BATCH_ITEMS", 12),
} as const;
