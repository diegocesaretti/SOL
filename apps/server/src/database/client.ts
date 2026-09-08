import pg from "pg";
import { config } from "../config.js";
import { wakeOutbox } from "../core/outbox-wakeup.js";
import { normalizePostgresConnectionString } from "./postgres-url.js";

const { Pool } = pg;

export const db = new Pool({
  connectionString: normalizePostgresConnectionString(config.databaseUrl),
  max: config.databasePoolMax,
  idleTimeoutMillis: config.databaseIdleTimeoutMs,
  connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
});

// Every physical pool connection listens while it is alive. The pool deliberately
// releases idle clients quickly, so this does not keep Neon awake indefinitely.
// When Neon resumes and pg creates a fresh connection, LISTEN is installed again.
db.on("connect", (client) => {
  client.on("notification", (message) => {
    if (message.channel === "sol_outbox") wakeOutbox();
  });
  void client.query("LISTEN sol_outbox").catch((error) => {
    console.error("Could not enable SOL outbox notifications", error);
  });
});

export async function checkDatabase(): Promise<boolean> {
  try {
    await db.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  await db.end();
}
