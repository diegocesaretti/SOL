import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { db, closeDatabase } from "./client.js";

const migrationsDir = fileURLToPath(
  new URL("../../../../packages/database/migrations/", import.meta.url),
);

async function ensureMigrationTable(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function baselineLegacyInitialMigration(filename: string): Promise<boolean> {
  if (filename !== "0001_initial.sql") return false;

  const result = await db.query<{ exists: string | null }>(
    "SELECT to_regclass('public.households')::text AS exists",
  );
  if (!result.rows[0]?.exists) return false;

  await db.query(
    "INSERT INTO schema_migrations(filename) VALUES ($1) ON CONFLICT DO NOTHING",
    [filename],
  );
  console.log(`Baseline recorded: ${filename}`);
  return true;
}

function stripOuterTransaction(sql: string): string {
  return sql
    .replace(/^\s*BEGIN;\s*/i, "")
    .replace(/\s*COMMIT;\s*$/i, "");
}

async function migrate(): Promise<void> {
  await ensureMigrationTable();

  const files = (await readdir(migrationsDir))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort();

  for (const filename of files) {
    const applied = await db.query(
      "SELECT 1 FROM schema_migrations WHERE filename = $1",
      [filename],
    );
    if (applied.rowCount) continue;

    if (await baselineLegacyInitialMigration(filename)) continue;

    const sql = stripOuterTransaction(
      await readFile(`${migrationsDir}${filename}`, "utf8"),
    );
    const client = await db.connect();
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
    } finally {
      client.release();
    }
  }
}

migrate()
  .then(() => closeDatabase())
  .catch(async (error) => {
    console.error("Database migration failed", error);
    await closeDatabase();
    process.exitCode = 1;
  });
