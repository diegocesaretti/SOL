import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import EmbeddedPostgres from "embedded-postgres";

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test(
  "local-first sync journal captures local writes and ignores replica writes",
  { skip: process.platform !== "win32" ? "SOL Full embedded PostgreSQL integration is Windows-targeted" : false },
  async () => {
  const root = await mkdtemp(join(tmpdir(), "sol-local-first-"));
  const port = await freePort();
  const postgres = new EmbeddedPostgres({
    databaseDir: join(root, "data"),
    port,
    user: "sol_test",
    password: "sol_test_password",
    persistent: true,
    authMethod: "scram-sha-256",
    onLog: () => undefined,
    onError: () => undefined,
  });

  try {
    await postgres.initialise();
    await postgres.start();
    await postgres.createDatabase("sol_test");

    const client = postgres.getPgClient("sol_test", "127.0.0.1");
    await client.connect();
    try {
      await client.query(`
        CREATE TABLE sync_probe (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          label text NOT NULL
        )
      `);

      const migrationPath = fileURLToPath(
        new URL("../../../../packages/database/migrations/0024_local_first_cloud_sync.sql", import.meta.url),
      );
      await client.query(await readFile(migrationPath, "utf8"));

      const inserted = await client.query<{ id: string }>(
        "INSERT INTO sync_probe(label) VALUES ('local') RETURNING id::text",
      );
      const id = inserted.rows[0]!.id;

      let journal = await client.query<{
        operation: string;
        primary_key: { id: string };
        row_data: { id: string; label: string } | null;
      }>(
        "SELECT operation, primary_key, row_data FROM sol_sync_changes ORDER BY seq",
      );
      assert.equal(journal.rowCount, 1);
      assert.equal(journal.rows[0]!.operation, "I");
      assert.equal(journal.rows[0]!.primary_key.id, id);
      assert.equal(journal.rows[0]!.row_data?.label, "local");

      await client.query("BEGIN");
      await client.query("SET LOCAL sol.sync_apply = '1'");
      await client.query("UPDATE sync_probe SET label = 'replica' WHERE id = $1", [id]);
      await client.query("COMMIT");

      journal = await client.query(
        "SELECT operation, primary_key, row_data FROM sol_sync_changes ORDER BY seq",
      );
      assert.equal(journal.rowCount, 1, "replica-applied writes must not echo into the journal");

      await client.query("DELETE FROM sync_probe WHERE id = $1", [id]);
      journal = await client.query(
        "SELECT operation, primary_key, row_data FROM sol_sync_changes ORDER BY seq",
      );
      assert.equal(journal.rowCount, 2);
      assert.equal(journal.rows[1]!.operation, "D");
      assert.equal(journal.rows[1]!.primary_key.id, id);
      assert.equal(journal.rows[1]!.row_data, null);
    } finally {
      await client.end();
    }
  } finally {
    await postgres.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
  },
);
