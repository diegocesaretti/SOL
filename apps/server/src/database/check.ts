import { config } from "../config.js";
import { closeDatabase, db } from "./client.js";

async function check(): Promise<void> {
  const started = Date.now();
  const result = await db.query<{
    database: string;
    username: string;
    version: string;
  }>(
    `SELECT current_database() AS database,
            current_user AS username,
            version() AS version`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("PostgreSQL returned no status row");

  let host = "configured PostgreSQL";
  try {
    host = new URL(config.databaseUrl).host || host;
  } catch {
    // Never print the full connection string if URL parsing fails.
  }

  console.log("SOL PostgreSQL is reachable.");
  console.log(`Host:     ${host}`);
  console.log(`Database: ${row.database}`);
  console.log(`User:     ${row.username}`);
  console.log(`Latency:  ${Date.now() - started} ms`);
  console.log(`Server:   ${row.version.split(",")[0]}`);
}

check()
  .then(() => closeDatabase())
  .catch(async (error) => {
    console.error("SOL PostgreSQL check failed:", error instanceof Error ? error.message : error);
    await closeDatabase().catch(() => undefined);
    process.exitCode = 1;
  });
