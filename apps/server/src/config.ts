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

export const config = {
  host: process.env.SOL_HOST ?? "127.0.0.1",
  port: integerEnv("SOL_PORT", 3000),
  logLevel: process.env.SOL_LOG_LEVEL ?? "info",
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgresql://sol:sol_dev_only@localhost:5432/sol",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
} as const;
