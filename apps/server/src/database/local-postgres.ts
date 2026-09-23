import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import EmbeddedPostgres from "embedded-postgres";
import { config } from "../config.js";

interface LocalPostgresState {
  password: string;
  port: number;
}

interface LocalPostgresRuntime {
  connectionString: string;
  stop(): Promise<void>;
}

const runtimeDir = resolve(config.dataDir, "postgres");
const clusterDir = resolve(runtimeDir, "cluster");
const statePath = resolve(runtimeDir, "runtime.json");
const pgVersionPath = resolve(clusterDir, "PG_VERSION");

let runtimePromise: Promise<LocalPostgresRuntime> | undefined;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function loadOrCreateState(): Promise<LocalPostgresState> {
  await mkdir(runtimeDir, { recursive: true });

  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as Partial<LocalPostgresState>;
    if (typeof parsed.password === "string" && parsed.password.length >= 24 && Number.isInteger(parsed.port)) {
      return { password: parsed.password, port: parsed.port as number };
    }
  } catch {}

  const state: LocalPostgresState = {
    password: randomBytes(32).toString("base64url"),
    port: config.localPostgresPort,
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
  return state;
}

async function startLocalPostgres(): Promise<LocalPostgresRuntime> {
  const state = await loadOrCreateState();
  const freshCluster = !(await exists(pgVersionPath));

  const postgres = new EmbeddedPostgres({
    databaseDir: clusterDir,
    user: "sol_local",
    password: state.password,
    port: state.port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8"],
  });

  if (freshCluster) {
    console.log("[database] Initializing embedded PostgreSQL");
    await postgres.initialise();
  }

  await postgres.start();

  if (freshCluster) {
    await postgres.createDatabase("sol");
  }

  const password = encodeURIComponent(state.password);
  const connectionString = `postgresql://sol_local:${password}@127.0.0.1:${state.port}/sol`;
  console.log(`[database] Embedded PostgreSQL ready on 127.0.0.1:${state.port}`);

  return {
    connectionString,
    stop: async () => {
      await postgres.stop().catch(() => undefined);
    },
  };
}

export function ensureLocalPostgres(): Promise<LocalPostgresRuntime> {
  runtimePromise ??= startLocalPostgres();
  return runtimePromise;
}
