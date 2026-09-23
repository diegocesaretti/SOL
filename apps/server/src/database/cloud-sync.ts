import pg, { type Pool, type PoolClient } from "pg";
import { config } from "../config.js";
import { db } from "./client.js";
import { migrateDatabase } from "./migration-runner.js";
import { normalizePostgresConnectionString } from "./postgres-url.js";

const { Pool: PgPool } = pg;

type CloudSyncStateName =
  | "disabled"
  | "bootstrap_required"
  | "offline"
  | "syncing"
  | "synchronized"
  | "conflict";

export interface CloudSyncStatus {
  state: CloudSyncStateName;
  cloudAvailable: boolean;
  pendingChanges: number;
  lastSyncAt?: string;
  lastError?: string;
}

interface SyncStateRow {
  authority_id: string;
  bootstrapped_at: Date | null;
  last_pushed_seq: string;
  last_sync_at: Date | null;
  last_sync_error: string | null;
}

interface SyncChangeRow {
  seq: string;
  table_name: string;
  operation: "I" | "U" | "D";
  primary_key_text: string;
  row_data_text: string | null;
}

interface TableMetadata {
  columns: string[];
  primaryKey: string[];
}

const SNAPSHOT_PAGE_SIZE = 500;
const MAX_BOOTSTRAP_ATTEMPTS = 3;

let remotePool: Pool | undefined;
let cloudSchemaReady = false;
let timer: NodeJS.Timeout | undefined;
let stopped = false;
let syncInFlight: Promise<void> | undefined;
let status: CloudSyncStatus = {
  state: config.cloudSyncEnabled ? "offline" : "disabled",
  cloudAvailable: false,
  pendingChanges: 0,
};

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function tableReference(table: string): string {
  return `public.${quoteIdentifier(table)}`;
}

function cloudPool(): Pool {
  if (remotePool) return remotePool;

  remotePool = new PgPool({
    connectionString: normalizePostgresConnectionString(config.databaseUrl),
    max: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
    allowExitOnIdle: true,
  });
  remotePool.on("error", (error) => {
    console.error("[database:cloud] idle Neon connection failed", error);
  });
  return remotePool;
}

async function ensureCloudSchema(): Promise<Pool> {
  const pool = cloudPool();
  if (!cloudSchemaReady) {
    await migrateDatabase(pool, "cloud");
    cloudSchemaReady = true;
  }
  return pool;
}

async function readSyncState(pool: Pool = db): Promise<SyncStateRow> {
  const result = await pool.query<SyncStateRow>(`
    SELECT
      authority_id::text,
      bootstrapped_at,
      last_pushed_seq::text,
      last_sync_at,
      last_sync_error
    FROM sol_cloud_sync_state
    WHERE singleton = true
  `);
  const row = result.rows[0];
  if (!row) throw new Error("SOL cloud sync state is missing");
  return row;
}

async function pendingChangeCount(): Promise<number> {
  const result = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM sol_sync_changes",
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function hasLocalDomainData(): Promise<boolean> {
  const result = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM households",
  );
  return Number(result.rows[0]?.count ?? 0) > 0;
}

async function markExistingLocalAsBootstrapped(): Promise<void> {
  await db.query(`
    UPDATE sol_cloud_sync_state
    SET bootstrapped_at = COALESCE(bootstrapped_at, now()),
        last_sync_error = NULL
    WHERE singleton = true
  `);
}

async function listApplicationTables(client: PoolClient): Promise<string[]> {
  const result = await client.query<{ relname: string }>(`
    SELECT class.relname
    FROM pg_class class
    JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
    WHERE namespace.nspname = 'public'
      AND class.relkind IN ('r', 'p')
      AND class.relname NOT IN (
        'schema_migrations',
        'sol_cloud_sync_state',
        'sol_sync_changes'
      )
    ORDER BY class.relname
  `);
  return result.rows.map((row) => row.relname);
}

async function tableMetadata(client: PoolClient, table: string): Promise<TableMetadata> {
  const columns = await client.query<{ column_name: string }>(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND is_generated = 'NEVER'
    ORDER BY ordinal_position
  `, [table]);

  const primaryKey = await client.query<{ attname: string }>(`
    SELECT attribute.attname
    FROM pg_index index_info
    JOIN LATERAL unnest(index_info.indkey) WITH ORDINALITY AS key(attnum, ordering)
      ON true
    JOIN pg_attribute attribute
      ON attribute.attrelid = index_info.indrelid
     AND attribute.attnum = key.attnum
    JOIN pg_class class ON class.oid = index_info.indrelid
    JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
    WHERE namespace.nspname = 'public'
      AND class.relname = $1
      AND index_info.indisprimary
    ORDER BY key.ordering
  `, [table]);

  return {
    columns: columns.rows.map((row) => row.column_name),
    primaryKey: primaryKey.rows.map((row) => row.attname),
  };
}

async function insertSnapshotPage(
  client: PoolClient,
  table: string,
  rowsJson: string,
): Promise<void> {
  const metadata = await tableMetadata(client, table);
  if (!metadata.columns.length) return;

  const columns = metadata.columns.map(quoteIdentifier).join(", ");
  const relation = tableReference(table);
  await client.query(
    `INSERT INTO ${relation} (${columns}) OVERRIDING SYSTEM VALUE
     SELECT ${columns}
     FROM jsonb_populate_recordset(NULL::${relation}, $1::jsonb)`,
    [rowsJson],
  );
}

async function resetOwnedSequences(client: PoolClient): Promise<void> {
  const sequences = await client.query<{
    table_name: string;
    column_name: string;
    sequence_name: string;
  }>(`
    SELECT
      columns.table_name,
      columns.column_name,
      pg_get_serial_sequence(
        format('%I.%I', columns.table_schema, columns.table_name),
        columns.column_name
      ) AS sequence_name
    FROM information_schema.columns columns
    WHERE columns.table_schema = 'public'
      AND pg_get_serial_sequence(
        format('%I.%I', columns.table_schema, columns.table_name),
        columns.column_name
      ) IS NOT NULL
  `);

  for (const row of sequences.rows) {
    const relation = tableReference(row.table_name);
    const column = quoteIdentifier(row.column_name);
    await client.query(
      `SELECT setval(
         $1::regclass,
         COALESCE((SELECT max(${column}) FROM ${relation}), 1),
         EXISTS (SELECT 1 FROM ${relation})
       )`,
      [row.sequence_name],
    );
  }
}

async function cloudJournalCount(client: PoolClient): Promise<number> {
  const result = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM sol_sync_changes",
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function bootstrapSnapshotOnce(pool: Pool, authorityId: string): Promise<void> {
  const cloud = await pool.connect();
  const local = await db.connect();
  let cloudTransaction = false;
  let localTransaction = false;

  try {
    await cloud.query("DELETE FROM sol_sync_changes");
    await cloud.query(
      `UPDATE sol_cloud_sync_state
       SET authority_id = $1::uuid,
           bootstrapped_at = NULL,
           last_pushed_seq = 0,
           last_sync_at = NULL,
           last_sync_error = NULL
       WHERE singleton = true`,
      [authorityId],
    );

    await cloud.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    cloudTransaction = true;
    await local.query("BEGIN");
    localTransaction = true;
    await local.query("SET LOCAL session_replication_role = replica");
    await local.query("SET LOCAL sol.sync_apply = '1'");

    const cloudTables = await listApplicationTables(cloud);
    const localTables = new Set(await listApplicationTables(local));
    const tables = cloudTables.filter((table) => localTables.has(table));
    const cloudOnly = cloudTables.filter((table) => !localTables.has(table));
    if (cloudOnly.length) {
      console.warn(
        `[database:cloud] Cloud-only tables were not imported: ${cloudOnly.join(", ")}`,
      );
    }

    if (tables.length) {
      await local.query(
        `TRUNCATE TABLE ${tables.map(tableReference).join(", ")} RESTART IDENTITY CASCADE`,
      );
    }

    for (const table of tables) {
      let offset = 0;
      while (true) {
        const page = await cloud.query<{ row_data: string }>(
          `SELECT to_jsonb(source_row)::text AS row_data
           FROM ${tableReference(table)} source_row
           ORDER BY ctid
           LIMIT $1 OFFSET $2`,
          [SNAPSHOT_PAGE_SIZE, offset],
        );
        if (!page.rowCount) break;

        const rowsJson = `[${page.rows.map((row) => row.row_data).join(",")}]`;
        await insertSnapshotPage(local, table, rowsJson);
        offset += page.rows.length;
        if (page.rows.length < SNAPSHOT_PAGE_SIZE) break;
      }
    }

    await resetOwnedSequences(local);
    await cloud.query("COMMIT");
    cloudTransaction = false;

    if (await cloudJournalCount(cloud)) {
      throw new Error("Neon changed while the initial local snapshot was being copied");
    }

    await local.query(
      `UPDATE sol_cloud_sync_state
       SET authority_id = $1::uuid,
           bootstrapped_at = now(),
           last_pushed_seq = 0,
           last_sync_at = now(),
           last_sync_error = NULL
       WHERE singleton = true`,
      [authorityId],
    );
    await local.query("COMMIT");
    localTransaction = false;

    await cloud.query(
      `UPDATE sol_cloud_sync_state
       SET authority_id = $1::uuid,
           bootstrapped_at = now(),
           last_pushed_seq = 0,
           last_sync_at = now(),
           last_sync_error = NULL
       WHERE singleton = true`,
      [authorityId],
    );
    await cloud.query("DELETE FROM sol_sync_changes");
  } finally {
    if (cloudTransaction) await cloud.query("ROLLBACK").catch(() => undefined);
    if (localTransaction) await local.query("ROLLBACK").catch(() => undefined);
    cloud.release();
    local.release();
  }
}

async function bootstrapFromCloud(): Promise<void> {
  const pool = await ensureCloudSchema();
  const localState = await readSyncState();

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_BOOTSTRAP_ATTEMPTS; attempt += 1) {
    try {
      await bootstrapSnapshotOnce(pool, localState.authority_id);
      console.log("[database] Initial Neon → local PostgreSQL snapshot complete");
      status = {
        state: "synchronized",
        cloudAvailable: true,
        pendingChanges: 0,
        lastSyncAt: new Date().toISOString(),
      };
      return;
    } catch (error) {
      lastError = error;
      console.warn(
        `[database:cloud] Initial snapshot attempt ${attempt}/${MAX_BOOTSTRAP_ATTEMPTS} failed`,
        error,
      );
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function initializeCloudSync(): Promise<void> {
  const localState = await readSyncState();

  if (localState.bootstrapped_at) {
    status = {
      state: config.cloudSyncEnabled ? "offline" : "disabled",
      cloudAvailable: false,
      pendingChanges: await pendingChangeCount(),
      lastSyncAt: localState.last_sync_at?.toISOString(),
      lastError: localState.last_sync_error ?? undefined,
    };
    return;
  }

  if (await hasLocalDomainData()) {
    await markExistingLocalAsBootstrapped();
    console.log("[database] Existing local SOL database adopted as local-first authority");
    status = {
      state: config.cloudSyncEnabled ? "offline" : "disabled",
      cloudAvailable: false,
      pendingChanges: await pendingChangeCount(),
    };
    return;
  }

  if (!config.cloudSyncEnabled) {
    await markExistingLocalAsBootstrapped();
    status = {
      state: "disabled",
      cloudAvailable: false,
      pendingChanges: 0,
    };
    return;
  }

  try {
    await bootstrapFromCloud();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status = {
      state: "bootstrap_required",
      cloudAvailable: false,
      pendingChanges: 0,
      lastError: message,
    };
    throw new Error(
      "SOL local-first database needs one successful Neon connection for its initial seed. " +
      "Neon is currently unavailable or quota-blocked; no local blank database was created to avoid diverging from your existing SOL Full data.",
      { cause: error },
    );
  }
}

async function remoteHasDomainData(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM households",
  );
  return Number(result.rows[0]?.count ?? 0) > 0;
}

async function ensureAuthority(pool: Pool, localState: SyncStateRow): Promise<void> {
  const remoteState = await readSyncState(pool);

  if (!remoteState.bootstrapped_at) {
    if (await remoteHasDomainData(pool)) {
      throw new Error(
        "Neon contains SOL data but is not paired with this local authority; automatic overwrite was blocked",
      );
    }
    await pool.query(
      `UPDATE sol_cloud_sync_state
       SET authority_id = $1::uuid,
           bootstrapped_at = now(),
           last_pushed_seq = 0,
           last_sync_error = NULL
       WHERE singleton = true`,
      [localState.authority_id],
    );
    return;
  }

  if (remoteState.authority_id !== localState.authority_id) {
    throw new Error(
      "Neon is paired with a different SOL local authority; automatic synchronization was blocked",
    );
  }
}

async function applyUpsert(
  client: PoolClient,
  metadata: TableMetadata,
  table: string,
  rowDataText: string,
): Promise<void> {
  if (!metadata.columns.length || !metadata.primaryKey.length) {
    throw new Error(`Cannot sync ${table}: table has no insertable columns or primary key`);
  }

  const relation = tableReference(table);
  const columns = metadata.columns.map(quoteIdentifier);
  const conflict = metadata.primaryKey.map(quoteIdentifier);
  const primary = new Set(metadata.primaryKey);
  const updateColumns = metadata.columns.filter((column) => !primary.has(column));

  const conflictAction = updateColumns.length
    ? `DO UPDATE SET ${updateColumns
        .map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`)
        .join(", ")}`
    : "DO NOTHING";

  await client.query(
    `INSERT INTO ${relation} (${columns.join(", ")}) OVERRIDING SYSTEM VALUE
     SELECT ${columns.join(", ")}
     FROM jsonb_populate_record(NULL::${relation}, $1::jsonb)
     ON CONFLICT (${conflict.join(", ")}) ${conflictAction}`,
    [rowDataText],
  );
}

async function applyDelete(
  client: PoolClient,
  metadata: TableMetadata,
  table: string,
  primaryKeyText: string,
): Promise<void> {
  if (!metadata.primaryKey.length) {
    throw new Error(`Cannot sync delete from ${table}: table has no primary key`);
  }

  const relation = tableReference(table);
  const conditions = metadata.primaryKey
    .map((column) => {
      const quoted = quoteIdentifier(column);
      return `target.${quoted} IS NOT DISTINCT FROM key_row.${quoted}`;
    })
    .join(" AND ");

  await client.query(
    `DELETE FROM ${relation} target
     USING jsonb_populate_record(NULL::${relation}, $1::jsonb) key_row
     WHERE ${conditions}`,
    [primaryKeyText],
  );
}

async function pushPendingChanges(pool: Pool, localState: SyncStateRow): Promise<number> {
  const pending = await db.query<SyncChangeRow>(
    `SELECT
       seq::text,
       table_name,
       operation,
       primary_key::text AS primary_key_text,
       row_data::text AS row_data_text
     FROM sol_sync_changes
     WHERE seq > $1::bigint
     ORDER BY seq
     LIMIT $2`,
    [localState.last_pushed_seq, config.cloudSyncBatchSize],
  );

  if (!pending.rowCount) return 0;

  const cloud = await pool.connect();
  const metadataCache = new Map<string, TableMetadata>();
  let transaction = false;
  try {
    if (await cloudJournalCount(cloud)) {
      throw new Error(
        "Neon received writes outside the SOL cloud replicator; synchronization stopped to avoid overwriting them",
      );
    }

    await cloud.query("BEGIN");
    transaction = true;
    await cloud.query("SET LOCAL sol.sync_apply = '1'");

    for (const change of pending.rows) {
      let metadata = metadataCache.get(change.table_name);
      if (!metadata) {
        metadata = await tableMetadata(cloud, change.table_name);
        metadataCache.set(change.table_name, metadata);
      }

      if (change.operation === "D") {
        await applyDelete(cloud, metadata, change.table_name, change.primary_key_text);
      } else {
        if (!change.row_data_text) {
          throw new Error(`Sync change ${change.seq} has no row data`);
        }
        await applyUpsert(cloud, metadata, change.table_name, change.row_data_text);
      }
    }

    const lastSeq = pending.rows.at(-1)!.seq;
    await cloud.query(
      `UPDATE sol_cloud_sync_state
       SET last_pushed_seq = $1::bigint,
           last_sync_at = now(),
           last_sync_error = NULL
       WHERE singleton = true`,
      [lastSeq],
    );
    await cloud.query("COMMIT");
    transaction = false;

    await db.query(
      `UPDATE sol_cloud_sync_state
       SET last_pushed_seq = $1::bigint,
           last_sync_at = now(),
           last_sync_error = NULL
       WHERE singleton = true`,
      [lastSeq],
    );
    await db.query("DELETE FROM sol_sync_changes WHERE seq <= $1::bigint", [lastSeq]);

    return pending.rows.length;
  } finally {
    if (transaction) await cloud.query("ROLLBACK").catch(() => undefined);
    cloud.release();
  }
}

async function recordLocalSyncError(message: string): Promise<void> {
  await db.query(
    `UPDATE sol_cloud_sync_state
     SET last_sync_error = $1
     WHERE singleton = true`,
    [message],
  ).catch(() => undefined);
}

async function performCloudSync(): Promise<void> {
  if (!config.cloudSyncEnabled || stopped || status.state === "conflict") return;

  const pendingBefore = await pendingChangeCount();
  if (pendingBefore === 0 && status.state === "synchronized") {
    status = { ...status, pendingChanges: 0 };
    return;
  }

  status = {
    ...status,
    state: "syncing",
    pendingChanges: pendingBefore,
  };

  try {
    const pool = await ensureCloudSchema();
    const localState = await readSyncState();
    await ensureAuthority(pool, localState);

    let applied = 0;
    while (true) {
      const currentState = await readSyncState();
      const count = await pushPendingChanges(pool, currentState);
      applied += count;
      if (count < config.cloudSyncBatchSize) break;
    }

    const now = new Date().toISOString();
    await db.query(
      `UPDATE sol_cloud_sync_state
       SET last_sync_at = now(),
           last_sync_error = NULL
       WHERE singleton = true`,
    );
    status = {
      state: "synchronized",
      cloudAvailable: true,
      pendingChanges: await pendingChangeCount(),
      lastSyncAt: now,
    };
    if (applied) {
      console.log(`[database:cloud] Synchronized ${applied} local change(s) to Neon`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const conflict =
      message.includes("different SOL local authority") ||
      message.includes("outside the SOL cloud replicator") ||
      message.includes("not paired with this local authority");
    status = {
      state: conflict ? "conflict" : "offline",
      cloudAvailable: false,
      pendingChanges: await pendingChangeCount().catch(() => status.pendingChanges),
      lastSyncAt: status.lastSyncAt,
      lastError: message,
    };
    await recordLocalSyncError(message);
    console.warn(
      conflict ? "[database:cloud] Synchronization conflict" : "[database:cloud] Neon unavailable; SOL remains local",
      message,
    );
  }
}

function scheduleNextSync(): void {
  if (stopped || !config.cloudSyncEnabled) return;
  timer = setTimeout(() => {
    timer = undefined;
    void syncCloudNow().finally(scheduleNextSync);
  }, config.cloudSyncIntervalMs);
  timer.unref();
}

export async function syncCloudNow(): Promise<void> {
  if (!config.cloudSyncEnabled || stopped) return;
  syncInFlight ??= performCloudSync().finally(() => {
    syncInFlight = undefined;
  });
  return syncInFlight;
}

export function startCloudSync(): void {
  if (!config.cloudSyncEnabled || stopped) return;
  void syncCloudNow().finally(scheduleNextSync);
}

export async function stopCloudSync(): Promise<void> {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  await syncInFlight?.catch(() => undefined);
  const pool = remotePool;
  remotePool = undefined;
  cloudSchemaReady = false;
  if (pool) await pool.end().catch(() => undefined);
}

export async function getCloudSyncStatus(): Promise<CloudSyncStatus> {
  return {
    ...status,
    pendingChanges: await pendingChangeCount().catch(() => status.pendingChanges),
  };
}
