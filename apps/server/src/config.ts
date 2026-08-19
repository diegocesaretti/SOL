import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const rootEnvPath = fileURLToPath(new URL("../../../.env", import.meta.url));

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

export const config = {
  host: process.env.SOL_HOST ?? "127.0.0.1",
  port: integerEnv("SOL_PORT", 3000),
  logLevel: process.env.SOL_LOG_LEVEL ?? "info",
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgresql://sol:sol_dev_only@localhost:5432/sol",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  sessionDays: integerEnv("SOL_SESSION_DAYS", 30),
  cookieSecure: booleanEnv("SOL_COOKIE_SECURE", false),
  codexBin: process.env.SOL_CODEX_BIN?.trim() || "codex",
  codexHome: optionalEnv("SOL_CODEX_HOME"),
  codexWorkingDirectory: optionalEnv("SOL_CODEX_CWD"),
  codexRequestTimeoutMs: integerEnv("SOL_CODEX_REQUEST_TIMEOUT_MS", 30_000),
  outboxPollMs: integerEnv("SOL_OUTBOX_POLL_MS", 2_000),
} as const;
