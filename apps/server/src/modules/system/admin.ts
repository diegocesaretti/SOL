import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../../config.js";
import { db } from "../../database/client.js";
import type { AuthPrincipal } from "../auth/session.js";
import { pluginManager } from "../plugins/runtime.js";

export type SolResetMode = "database" | "factory";

export class SystemAdminError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "SystemAdminError";
  }
}

function requireOwner(principal: AuthPrincipal): void {
  if (principal.role !== "owner") throw new SystemAdminError("owner_required", 403);
}

function databaseSummary(): { host?: string; database?: string; ssl: boolean } {
  try {
    const url = new URL(config.databaseUrl);
    return {
      host: url.hostname || undefined,
      database: url.pathname.replace(/^\//, "") || undefined,
      ssl: /sslmode=/i.test(url.search) || url.searchParams.get("ssl") === "true",
    };
  } catch {
    return { ssl: false };
  }
}

export async function getSystemAdminState(principal: AuthPrincipal): Promise<Record<string, unknown>> {
  requireOwner(principal);
  const legacy = await db.query<{ legacy_nexo: string | null }>(
    "SELECT to_regnamespace('whatsapp_nexo')::text AS legacy_nexo",
  );
  return {
    database: databaseSummary(),
    legacyNexoSchemaPresent: Boolean(legacy.rows[0]?.legacy_nexo),
    reset: {
      databaseConfirmation: "REINICIAR DATOS",
      factoryConfirmation: "RESTABLECER SOL",
      databaseKeeps: ["DATABASE_URL", "plugins instalados", "datos locales de plugins"],
      factoryKeeps: ["logs de diagnóstico"],
    },
  };
}

async function clearSolDatabase(dropLegacyNexo: boolean): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Every current SOL domain table hangs from households through FK constraints.
    // CASCADE therefore clears SOL-owned rows without dropping the public schema,
    // migration history, extensions, or unrelated tables in a shared Neon database.
    await client.query("TRUNCATE TABLE households RESTART IDENTITY CASCADE");
    if (dropLegacyNexo) await client.query("DROP SCHEMA IF EXISTS whatsapp_nexo CASCADE");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function requestLauncherFactoryReset(): Promise<void> {
  const solDir = resolve(config.repoRoot, ".sol");
  await mkdir(solDir, { recursive: true });
  await writeFile(resolve(solDir, "factory-reset-requested"), new Date().toISOString() + "\n", "utf8");
}

export async function resetSol(
  principal: AuthPrincipal,
  input: { mode?: string; confirmation?: string },
): Promise<{ ok: true; mode: SolResetMode; restart: true }> {
  requireOwner(principal);
  const mode: SolResetMode | null = input.mode === "database" || input.mode === "factory" ? input.mode : null;
  if (!mode) throw new SystemAdminError("mode_must_be_database_or_factory");
  const expected = mode === "factory" ? "RESTABLECER SOL" : "REINICIAR DATOS";
  if (input.confirmation?.trim() !== expected) throw new SystemAdminError("confirmation_phrase_mismatch");

  // Stop providers first so no plugin can race the destructive operation and write
  // rows back while the reset transaction is in progress.
  await pluginManager.shutdown();
  await clearSolDatabase(mode === "factory");
  if (mode === "factory") await requestLauncherFactoryReset();

  // 43 means restart preserving local configuration. 42 tells SOL.exe to perform
  // local cleanup (.env/plugins/plugin-data) and return to the Neon setup screen.
  setTimeout(() => process.exit(mode === "factory" ? 42 : 43), 250).unref?.();
  return { ok: true, mode, restart: true };
}
