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

const codexHome = optionalEnv("SOL_CODEX_HOME") ?? resolve(repoRoot, ".sol", "codex");
const host = process.env.SOL_HOST ?? "127.0.0.1";
const port = integerEnv("SOL_PORT", 3000);
const googleClientId = optionalEnv("SOL_GOOGLE_CLIENT_ID");
const googleClientSecret = optionalEnv("SOL_GOOGLE_CLIENT_SECRET");

export const config = {
  repoRoot,
  host,
  port,
  logLevel: process.env.SOL_LOG_LEVEL ?? "info",
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgresql://sol:sol_dev_only@127.0.0.1:5432/sol",
  // Small/short-lived pools work well both with local PostgreSQL and scale-to-zero
  // providers such as Neon. A direct DATABASE_URL is preferred for migrations.
  databasePoolMax: integerEnv("SOL_DB_POOL_MAX", 4),
  databaseIdleTimeoutMs: integerEnv("SOL_DB_IDLE_TIMEOUT_MS", 15_000),
  databaseConnectionTimeoutMs: integerEnv("SOL_DB_CONNECT_TIMEOUT_MS", 15_000),
  sessionDays: integerEnv("SOL_SESSION_DAYS", 30),
  cookieSecure: booleanEnv("SOL_COOKIE_SECURE", false),
  codexBin: process.env.SOL_CODEX_BIN?.trim() || "codex",
  codexHome,
  codexWorkingDirectory:
    optionalEnv("SOL_CODEX_CWD") ?? resolve(codexHome, "workspace"),
  codexRequestTimeoutMs: integerEnv("SOL_CODEX_REQUEST_TIMEOUT_MS", 30_000),
  // PostgreSQL NOTIFY wakes the outbox immediately. This is only a recovery sweep.
  outboxPollMs: integerEnv("SOL_OUTBOX_RECOVERY_MS", 30 * 60 * 1000),
  googleClientId,
  googleClientSecret,
  googleRedirectUri:
    optionalEnv("SOL_GOOGLE_REDIRECT_URI") ??
    `http://${host}:${port}/v1/google/callback`,
  // Gmail can reuse the same Google OAuth Web client. Register the Gmail callback too.
  gmailClientId: optionalEnv("SOL_GMAIL_CLIENT_ID") ?? googleClientId,
  gmailClientSecret: optionalEnv("SOL_GMAIL_CLIENT_SECRET") ?? googleClientSecret,
  gmailRedirectUri:
    optionalEnv("SOL_GMAIL_REDIRECT_URI") ??
    `http://${host}:${port}/v1/gmail/callback`,
  mercadoLibreClientId: optionalEnv("SOL_MERCADOLIBRE_CLIENT_ID"),
  mercadoLibreClientSecret: optionalEnv("SOL_MERCADOLIBRE_CLIENT_SECRET"),
  // Mercado Libre currently requires this URI to be HTTPS and to exactly match
  // the static URI registered in the application configuration.
  mercadoLibreRedirectUri: optionalEnv("SOL_MERCADOLIBRE_REDIRECT_URI"),
  mercadoLibreAuthUrl:
    optionalEnv("SOL_MERCADOLIBRE_AUTH_URL") ??
    "https://auth.mercadolibre.com.ar/authorization",
  // Cloud-friendly defaults leave long idle windows so scale-to-zero can engage.
  calendarSyncMs: integerEnv("SOL_CALENDAR_SYNC_MS", 60 * 60 * 1000),
  gmailSyncMs: integerEnv("SOL_GMAIL_SYNC_MS", 15 * 60 * 1000),
  mercadoLibreSyncMs: integerEnv("SOL_MERCADOLIBRE_SYNC_MS", 60 * 60 * 1000),
  executivePollMs: integerEnv("SOL_EXECUTIVE_POLL_MS", 30 * 60 * 1000),
  // Knowledge consolidation is optional AI enrichment. Sparse batches keep Neon and
  // ChatGPT/Codex usage low; ingestion/MCP continue normally when Codex is unavailable.
  knowledgeConsolidationMs: integerEnv("SOL_KNOWLEDGE_CONSOLIDATION_MS", 6 * 60 * 60 * 1000),
  knowledgeBatchesPerRun: integerEnv("SOL_KNOWLEDGE_BATCHES_PER_RUN", 2),
  knowledgeBatchItems: integerEnv("SOL_KNOWLEDGE_BATCH_ITEMS", 12),
} as const;
