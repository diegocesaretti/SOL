import { closeDatabase, db } from "./client.js";

async function check(): Promise<void> {
  const started = Date.now();
  const result = await db.query<{
    database: string;
    username: string;
    version: string;
    host: string | null;
    port: number | null;
  }>(
    `SELECT current_database() AS database,
            current_user AS username,
            version() AS version,
            inet_server_addr()::text AS host,
            inet_server_port() AS port`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("PostgreSQL returned no status row");

  console.log("SOL local PostgreSQL is reachable.");
  console.log(`Host:     ${row.host ?? "local socket"}${row.port ? `:${row.port}` : ""}`);
  console.log(`Database: ${row.database}`);
  console.log(`User:     ${row.username}`);
  console.log(`Latency:  ${Date.now() - started} ms`);
  console.log(`Server:   ${row.version.split(",")[0]}`);
}

check()
  .then(() => closeDatabase())
  .catch(async (error) => {
    console.error("SOL local PostgreSQL check failed:", error instanceof Error ? error.message : error);
    await closeDatabase().catch(() => undefined);
    process.exitCode = 1;
  });
