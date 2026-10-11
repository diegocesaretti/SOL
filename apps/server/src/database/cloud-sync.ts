import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Pool, PoolClient } from "pg";
import { config } from "../config.js";
import { sourceCopySelection, type CopyColumn } from "./copy-values.js";
import { cloudDb, db, databaseRuntimeMode } from "./client.js";
import { migrateDatabase } from "./migration-runner.js";

type CloudSyncStateName =
  | "disabled"
  | "ready"
  | "unseeded_offline"
  | "seeding"
  | "syncing"
  | "offline"
  | "error";

interface PersistedCloudSyncState {
  seeded: boolean;
  lastPullAt?: string;
  lastPushAt?: string;
  lastError?: string;
  cloudReachable?: boolean;
  lastCloudCheckAt?: string;
}

export interface CloudSyncStatus extends PersistedCloudSyncState {
  state: CloudSyncStateName;
  cloudConfigured: boolean;
}

const stateDir = resolve(config.dataDir, "database");
const statePath = resolve(stateDir, "cloud-sync-state.json");

let state: CloudSyncStatus = {
  state: databaseRuntimeMode === "hybrid" ? "offline" : "disabled",
  cloudConfigured: Boolean(cloudDb),
  seeded: false,
};

let timer: NodeJS.Timeout | undefined;
let recoveryTimer: NodeJS.Timeout | undefined;
let busy = false;

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function loadState(): Promise<void> {
  if (databaseRuntimeMode !== "hybrid") return;
  await mkdir(stateDir, { recursive: true });
  try {
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as PersistedCloudSyncState;
    state = { ...state, ...persisted };
  } catch {}
}

async function saveState(): Promise<void> {
  if (databaseRuntimeMode !== "hybrid") return;
  await mkdir(stateDir, { recursive: true });
  const persisted: PersistedCloudSyncState = {
    seeded: state.seeded,
    lastPullAt: state.lastPullAt,
    lastPushAt: state.lastPushAt,
    lastError: state.lastError,
    cloudReachable: state.cloudReachable,
    lastCloudCheckAt: state.lastCloudCheckAt,
  };
  await writeFile(statePath, JSON.stringify(persisted, null, 2), "utf8");
}

async function publicTables(client: PoolClient): Promise<string[]> {
  const result = await client.query<{ tablename: string }>(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);
  return result.rows.map((row) => row.tablename);
}

async function tableColumns(client: PoolClient, table: string): Promise<CopyColumn[]> {
  const result = await client.query<CopyColumn>(`
    SELECT column_name, udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [table]);
  return result.rows;
}

async function dependencyOrderedTables(client: PoolClient, tables: string[]): Promise<string[]> {
  const known = new Set(tables);
  const deps = new Map<string, Set<string>>(tables.map((table) => [table, new Set<string>()]));
  const result = await client.query<{ child: string; parent: string }>(`
    SELECT child.relname AS child, parent.relname AS parent
    FROM pg_constraint c
    JOIN pg_class child ON child.oid = c.conrelid
    JOIN pg_class parent ON parent.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = child.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
  `);

  for (const row of result.rows) {
    if (known.has(row.child) && known.has(row.parent) && row.child !== row.parent) {
      deps.get(row.child)?.add(row.parent);
    }
  }

  const ordered: string[] = [];
  const pending = new Set(tables);
  while (pending.size) {
    const ready = [...pending].filter((table) =>
      [...(deps.get(table) ?? [])].every((dep) => !pending.has(dep)),
    );
    if (!ready.length) return tables;
    ready.sort();
    for (const table of ready) {
      ordered.push(table);
      pending.delete(table);
    }
  }
  return ordered;
}

async function copyTable(source: PoolClient, target: PoolClient, table: string): Promise<void> {
  const columns = await tableColumns(source, table);
  if (!columns.length) return;
  const rows = await source.query(
    `SELECT ${sourceCopySelection(columns)} FROM ${quoteIdent(table)}`,
  );
  if (!rows.rows.length) return;

  const quotedColumns = columns.map((column) => quoteIdent(column.column_name)).join(", ");
  const batchSize = Math.min(100, Math.max(1, Math.floor(30000 / columns.length)));
  for (let offset = 0; offset < rows.rows.length; offset += batchSize) {
    const batch = rows.rows.slice(offset, offset + batchSize);
    const values = batch.flatMap((row) => columns.map((column) => row[column.column_name]));
    const placeholders = batch.map((_, rowIndex) =>
      "(" + columns.map((_, colIndex) => "$" + (rowIndex * columns.length + colIndex + 1)).join(", ") + ")",
    ).join(", ");
    await target.query(
      "INSERT INTO " + quoteIdent(table) + " (" + quotedColumns + ") VALUES " + placeholders,
      values,
    );
  }
}

async function resetSequences(client: PoolClient, tables: string[]): Promise<void> {
  for (const table of tables) {
    const columns = await client.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND (is_identity = 'YES' OR column_default LIKE 'nextval(%')
    `, [table]);

    for (const row of columns.rows) {
      const seq = await client.query<{ seq: string | null }>(
        "SELECT pg_get_serial_sequence($1, $2) AS seq",
        [`public.${table}`, row.column_name],
      );
      const sequence = seq.rows[0]?.seq;
      if (!sequence) continue;
      await client.query(
        `SELECT setval($1::regclass, COALESCE((SELECT MAX(${quoteIdent(row.column_name)}) FROM ${quoteIdent(table)}), 1), EXISTS(SELECT 1 FROM ${quoteIdent(table)}))`,
        [sequence],
      );
    }
  }
}

async function assertDestinationSubsetOfSource(source: PoolClient, target: PoolClient): Promise<void> {
  // A full-copy is permissible only if it will not erase destination-only keys.
  // The destination is held under an exclusive table lock by the caller.
  for (const table of await publicTables(target)) {
    const keys = await target.query<{ column_name: string }>(
      "SELECT kcu.column_name FROM information_schema.table_constraints tc " +
      "JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name " +
      "AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name " +
      "WHERE tc.table_schema = 'public' AND tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY' " +
      "ORDER BY kcu.ordinal_position",
      [table],
    );
    const columns = keys.rows.map((row) => row.column_name);
    if (!columns.length) {
      const existing = await target.query<{ occupied: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM " + quoteIdent(table) + ") AS occupied",
      );
      if (existing.rows[0]?.occupied)
        throw new Error("Refusing full-copy: destination table " + table + " has data but no primary key");
      continue;
    }
    const sql = "SELECT " + columns.map(quoteIdent).join(", ") + " FROM " + quoteIdent(table);
    const [sourceRows, targetRows] = await Promise.all([
      source.query<Record<string, unknown>>(sql),
      target.query<Record<string, unknown>>(sql),
    ]);
    const sourceKeys = new Set(sourceRows.rows.map((row) =>
      JSON.stringify(columns.map((column) => row[column])),
    ));
    const missing = targetRows.rows.filter((row) =>
      !sourceKeys.has(JSON.stringify(columns.map((column) => row[column]))),
    ).length;
    if (missing)
      throw new Error("Refusing full-copy: destination table " + table + " has " + missing + " destination-only rows");
  }
}

async function replaceDatabaseContents(sourcePool: Pool, targetPool: Pool): Promise<void> {
  const source = await sourcePool.connect();
  const target = await targetPool.connect();
  try {
    await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const tables = await publicTables(source);
    const ordered = await dependencyOrderedTables(source, tables);

    await target.query("BEGIN");
    if (tables.length) {
      await target.query("LOCK TABLE " + tables.map(quoteIdent).join(", ") + " IN ACCESS EXCLUSIVE MODE");
    }
    await assertDestinationSubsetOfSource(source, target);
    if (tables.length) {
      await target.query(
        `TRUNCATE TABLE ${tables.map(quoteIdent).join(", ")} RESTART IDENTITY CASCADE`,
      );
    }
    for (const table of ordered) {
      await copyTable(source, target, table);
    }
    await resetSequences(target, ordered);
    await target.query("COMMIT");
    await source.query("COMMIT");
  } catch (error) {
    await target.query("ROLLBACK").catch(() => undefined);
    await source.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    target.release();
    source.release();
  }
}

async function cloudReachable(): Promise<boolean> {
  if (!cloudDb) {
    state.cloudReachable = false;
    state.lastCloudCheckAt = new Date().toISOString();
    return false;
  }

  state.lastCloudCheckAt = new Date().toISOString();
  try {
    await cloudDb.query("SELECT 1");
    state.cloudReachable = true;
    return true;
  } catch {
    state.cloudReachable = false;
    return false;
  }
}

export async function retryCloudSeed(): Promise<boolean> {
  if (databaseRuntimeMode !== "hybrid" || !cloudDb) return false;
  if (state.seeded) return true;
  if (busy) return false;

  busy = true;
  try {
    if (!(await cloudReachable())) {
      state.state = "unseeded_offline";
      state.lastError = "Cloud database is unavailable and the local replica has not been seeded yet.";
      console.warn("[database] Neon unavailable before local seed; SOL will keep retrying recovery");
      return false;
    }

    state.state = "seeding";
    state.lastError = undefined;
    await migrateDatabase(cloudDb);
    await replaceDatabaseContents(cloudDb, db);
    state.seeded = true;
    state.lastPullAt = new Date().toISOString();
    state.state = "ready";
    console.log("[database] Local PostgreSQL seeded from Neon");
    return true;
  } catch (error) {
    state.state = "error";
    state.lastError = error instanceof Error ? error.message : String(error);
    console.error("[database] Cloud seed failed; SOL will retry recovery", error);
    return false;
  } finally {
    busy = false;
    await saveState();
  }
}

export async function initializeCloudSync(): Promise<void> {
  if (databaseRuntimeMode !== "hybrid" || !cloudDb) return;
  await loadState();

  if (state.seeded) {
    // Do not wake Neon merely because SOL started. The last known cloud status is
    // informational; scheduled sync will establish fresh reachability when needed.
    // A persisted sync failure must remain visible until an actual successful
    // transfer clears lastError. Cloud reachability alone is not sync health.
    state.state = state.cloudReachable === false ? "offline" : state.lastError ? "error" : "ready";
    await saveState();
    return;
  }

  await retryCloudSeed();
}

export async function syncLocalToCloud(): Promise<boolean> {
  if (busy || databaseRuntimeMode !== "hybrid" || !cloudDb || !state.seeded) return false;
  busy = true;
  try {
    if (!(await cloudReachable())) {
      state.state = "offline";
      return false;
    }

    state.state = "syncing";
    state.lastError = undefined;
    await migrateDatabase(cloudDb);
    await replaceDatabaseContents(db, cloudDb);
    state.lastPushAt = new Date().toISOString();
    state.state = "ready";
    console.log("[database] Local PostgreSQL synchronized to Neon");
    return true;
  } catch (error) {
    state.state = "error";
    state.lastError = error instanceof Error ? error.message : String(error);
    console.error("[database] Cloud synchronization failed", error);
    return false;
  } finally {
    busy = false;
    await saveState();
  }
}

export function startCloudSync(): void {
  if (databaseRuntimeMode !== "hybrid" || !cloudDb) return;

  if (!timer) {
    timer = setInterval(() => void syncLocalToCloud(), config.cloudSyncMs);
    timer.unref();
  }

  if (!recoveryTimer) {
    recoveryTimer = setInterval(() => {
      if (!state.seeded) void retryCloudSeed();
    }, config.cloudRecoveryMs);
    recoveryTimer.unref();
  }
}

export function stopCloudSync(): void {
  if (timer) clearInterval(timer);
  if (recoveryTimer) clearInterval(recoveryTimer);
  timer = undefined;
  recoveryTimer = undefined;
}

export function cloudSyncStatus(): CloudSyncStatus {
  return { ...state };
}
