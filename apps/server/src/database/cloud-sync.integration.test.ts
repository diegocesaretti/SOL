import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

const { Pool } = pg;

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
  return port;
}

function connectionString(
  port: number,
  database: string,
  user: string,
  password: string,
): string {
  const url = new URL(`postgresql://127.0.0.1/${database}`);
  url.port = String(port);
  url.username = user;
  url.password = password;
  url.searchParams.set("sslmode", "disable");
  return url.toString();
}

test(
  "local-first bootstrap, replication and conflict protection work end-to-end",
  { skip: process.platform !== "win32" ? "SOL Full embedded PostgreSQL integration is Windows-targeted" : false },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "sol-cloud-sync-"));
    const port = await freePort();
    const user = "sol_test";
    const password = "sol_test_password";
    const postgres = new EmbeddedPostgres({
      databaseDir: join(root, "data"),
      port,
      user,
      password,
      persistent: true,
      authMethod: "scram-sha-256",
      onLog: () => undefined,
      onError: () => undefined,
    });

    let cloudSeedPool: InstanceType<typeof Pool> | undefined;

    try {
      await postgres.initialise();
      await postgres.start();
      await postgres.createDatabase("sol_local");
      await postgres.createDatabase("sol_cloud");

      const localUrl = connectionString(port, "sol_local", user, password);
      const cloudUrl = connectionString(port, "sol_cloud", user, password);
      process.env.SOL_LOCAL_DATABASE_URL = localUrl;
      process.env.DATABASE_URL = cloudUrl;
      process.env.SOL_CLOUD_SYNC = "true";
      process.env.SOL_CLOUD_SYNC_MS = "1800000";
      process.env.SOL_DATA_DIR = join(root, "sol-data");

      const [{ db, closeDatabase }, { migrateDatabase }, cloudSync] = await Promise.all([
        import("./client.js"),
        import("./migration-runner.js"),
        import("./cloud-sync.js"),
      ]);

      cloudSeedPool = new Pool({ connectionString: cloudUrl, max: 1 });
      await migrateDatabase(cloudSeedPool, "cloud-test-seed");
      await cloudSeedPool.query(
        `INSERT INTO households(id, name, timezone)
         VALUES ('11111111-1111-4111-8111-111111111111', 'Cloud household', 'America/Argentina/Buenos_Aires')`,
      );

      await migrateDatabase(db, "local-test");
      await cloudSync.initializeCloudSync();

      const localSeed = await db.query<{ name: string }>(
        "SELECT name FROM households WHERE id = '11111111-1111-4111-8111-111111111111'",
      );
      assert.equal(localSeed.rows[0]?.name, "Cloud household");

      await db.query(
        `INSERT INTO households(id, name, timezone)
         VALUES ('22222222-2222-4222-8222-222222222222', 'Local household', 'UTC')`,
      );
      await cloudSync.syncCloudNow();

      const replicated = await cloudSeedPool.query<{ name: string }>(
        "SELECT name FROM households WHERE id = '22222222-2222-4222-8222-222222222222'",
      );
      assert.equal(replicated.rows[0]?.name, "Local household");
      assert.equal((await cloudSync.getCloudSyncStatus()).state, "synchronized");

      await cloudSeedPool.query(
        `UPDATE households
         SET name = 'Cloud external edit'
         WHERE id = '11111111-1111-4111-8111-111111111111'`,
      );
      await db.query(
        `UPDATE households
         SET name = 'Local edit'
         WHERE id = '11111111-1111-4111-8111-111111111111'`,
      );

      await cloudSync.syncCloudNow();
      const conflict = await cloudSync.getCloudSyncStatus();
      assert.equal(conflict.state, "conflict");

      const cloudAfterConflict = await cloudSeedPool.query<{ name: string }>(
        "SELECT name FROM households WHERE id = '11111111-1111-4111-8111-111111111111'",
      );
      const localAfterConflict = await db.query<{ name: string }>(
        "SELECT name FROM households WHERE id = '11111111-1111-4111-8111-111111111111'",
      );
      assert.equal(cloudAfterConflict.rows[0]?.name, "Cloud external edit");
      assert.equal(localAfterConflict.rows[0]?.name, "Local edit");

      await cloudSync.stopCloudSync();
      await closeDatabase();
    } finally {
      await cloudSeedPool?.end().catch(() => undefined);
      await postgres.stop().catch(() => undefined);
      delete process.env.SOL_LOCAL_DATABASE_URL;
      delete process.env.DATABASE_URL;
      delete process.env.SOL_CLOUD_SYNC;
      delete process.env.SOL_CLOUD_SYNC_MS;
      delete process.env.SOL_DATA_DIR;
      await rm(root, { recursive: true, force: true });
    }
  },
);
