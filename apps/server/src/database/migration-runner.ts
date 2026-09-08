import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { db } from "./client.js";

const migrationsDir = fileURLToPath(
  new URL("../../../../packages/database/migrations/", import.meta.url),
);

// Session-level lock held for the entire migration scan/application sequence.
// Two SOL processes can therefore start against the same database safely: the
// second waits, then re-scans schema_migrations after the first has completed.
const MIGRATION_LOCK_CLASS = 139770581;
const MIGRATION_LOCK_INSTANCE = 1;

// Migrations through 0020 existed before SOL introduced automatic migration
// bookkeeping. Some installed databases therefore already contain the schema
// produced by a migration while schema_migrations does not contain its filename.
// Keep this list explicit: a migration is adopted only when every object that
// uniquely proves that migration ran already exists.
const LEGACY_MIGRATION_SENTINELS: Readonly<Record<string, readonly string[]>> = {
  "0020_plugin_runtime_capabilities.sql": [
    "plugin_identity_bindings",
    "plugin_mcp_tools",
  ],
};

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function recordMigration(client: PoolClient, filename: string, label: string): Promise<void> {
  await client.query(
    "INSERT INTO schema_migrations(filename) VALUES ($1) ON CONFLICT DO NOTHING",
    [filename],
  );
  console.log(`${label}: ${filename}`);
}

async function baselineLegacyInitialMigration(
  client: PoolClient,
  filename: string,
): Promise<boolean> {
  if (filename !== "0001_initial.sql") return false;

  const result = await client.query<{ exists: string | null }>(
    "SELECT to_regclass('public.households')::text AS exists",
  );
  if (!result.rows[0]?.exists) return false;

  await recordMigration(client, filename, "Baseline recorded");
  return true;
}

async function adoptLegacyMigrationIfSatisfied(
  client: PoolClient,
  filename: string,
): Promise<boolean> {
  const sentinels = LEGACY_MIGRATION_SENTINELS[filename];
  if (!sentinels?.length) return false;

  for (const relation of sentinels) {
    const result = await client.query<{ exists: string | null }>(
      "SELECT to_regclass($1)::text AS exists",
      [`public.${relation}`],
    );
    if (!result.rows[0]?.exists) return false;
  }

  await recordMigration(client, filename, "Legacy migration adopted");
  return true;
}

function stripOuterTransaction(sql: string): string {
  return sql
    .replace(/^\s*BEGIN;\s*/i, "")
    .replace(/\s*COMMIT;\s*$/i, "");
}

export async function migrateDatabase(): Promise<void> {
  const client = await db.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock($1, $2)", [
      MIGRATION_LOCK_CLASS,
      MIGRATION_LOCK_INSTANCE,
    ]);
    locked = true;

    await ensureMigrationTable(client);
    const files = (await readdir(migrationsDir))
      .filter((file) => /^\d+_.+\.sql$/.test(file))
      .sort();

    for (const filename of files) {
      const applied = await client.query(
        "SELECT 1 FROM schema_migrations WHERE filename = $1",
        [filename],
      );
      if (applied.rowCount) continue;
      if (await baselineLegacyInitialMigration(client, filename)) continue;
      if (await adoptLegacyMigrationIfSatisfied(client, filename)) continue;

      const sql = stripOuterTransaction(await readFile(`${migrationsDir}${filename}`, "utf8"));
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations(filename) VALUES ($1)",
          [filename],
        );
        await client.query("COMMIT");
        console.log(`Applied migration: ${filename}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [
        MIGRATION_LOCK_CLASS,
        MIGRATION_LOCK_INSTANCE,
      ]).catch(() => undefined);
    }
    client.release();
  }
}

export function databaseMigrationsDirectory(): string {
  return migrationsDir;
}
