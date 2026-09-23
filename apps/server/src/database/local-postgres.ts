import { chmod, copyFile, cp, lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import crypto from "node:crypto";
import EmbeddedPostgres from "embedded-postgres";
import { config } from "../config.js";

interface LocalCredentials {
  user: string;
  password: string;
  database: string;
}

export interface LocalPostgresRuntime {
  connectionString: string;
  managed: boolean;
  stop(): Promise<void>;
}

const DEFAULT_USER = "sol_local";
const DEFAULT_DATABASE = "sol";

let runtimePromise: Promise<LocalPostgresRuntime> | undefined;

interface PortableSymlink {
  source: string;
  target: string;
}

async function hydratePortableWindowsPostgresFiles(): Promise<void> {
  if (process.platform !== "win32" || process.arch !== "x64") return;

  const require = createRequire(import.meta.url);
  const packageEntry = require.resolve("@embedded-postgres/windows-x64");
  const packageRoot = resolve(dirname(packageEntry), "..");
  const manifestPath = resolve(packageRoot, "native", "pg-symlinks.json");

  let links: PortableSymlink[];
  try {
    links = JSON.parse(await readFile(manifestPath, "utf8")) as PortableSymlink[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  for (const link of links) {
    const source = resolve(packageRoot, link.source);
    const target = resolve(packageRoot, link.target);

    try {
      await stat(target);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    // ZIP extraction and locked-down Windows hosts may not preserve/create
    // package symlinks. Replace a missing/broken link with a real copy so the
    // PostgreSQL runtime remains portable without Developer Mode/admin rights.
    await lstat(target).then(() => rm(target, { recursive: true, force: true })).catch(() => undefined);
    await mkdir(dirname(target), { recursive: true });
    const sourceStat = await stat(source);
    if (sourceStat.isDirectory()) {
      await cp(source, target, { recursive: true });
    } else {
      await copyFile(source, target);
    }
    if (config.logLevel === "debug") {
      console.log(`[database:local] hydrated portable PostgreSQL file ${link.target}`);
    }
  }
}

function localConnectionString(credentials: LocalCredentials): string {
  const url = new URL("postgresql://127.0.0.1");
  url.port = String(config.localDatabasePort);
  url.username = credentials.user;
  url.password = credentials.password;
  url.pathname = `/${credentials.database}`;
  url.searchParams.set("sslmode", "disable");
  return url.toString();
}

async function loadOrCreateCredentials(root: string): Promise<LocalCredentials> {
  const path = resolve(root, "credentials.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LocalCredentials>;
    if (
      typeof parsed.user === "string" &&
      parsed.user &&
      typeof parsed.password === "string" &&
      parsed.password &&
      typeof parsed.database === "string" &&
      parsed.database
    ) {
      return {
        user: parsed.user,
        password: parsed.password,
        database: parsed.database,
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const credentials: LocalCredentials = {
    user: DEFAULT_USER,
    database: DEFAULT_DATABASE,
    password: crypto.randomBytes(32).toString("base64url"),
  };
  await writeFile(path, JSON.stringify(credentials, null, 2) + "\n", {
    encoding: "utf8",
    flag: "wx",
  }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await chmod(path, 0o600).catch(() => undefined);

  return JSON.parse(await readFile(path, "utf8")) as LocalCredentials;
}

async function ensureDatabase(postgres: EmbeddedPostgres, database: string): Promise<void> {
  const client = postgres.getPgClient("postgres", "127.0.0.1");
  await client.connect();
  try {
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    if (!existing.rowCount) await postgres.createDatabase(database);
  } finally {
    await client.end();
  }
}

async function startManagedLocalPostgres(): Promise<LocalPostgresRuntime> {
  await hydratePortableWindowsPostgresFiles();

  const root = resolve(config.localDatabaseDir);
  const data = resolve(root, "data");
  await mkdir(root, { recursive: true });

  const credentials = await loadOrCreateCredentials(root);
  const postgres = new EmbeddedPostgres({
    databaseDir: data,
    port: config.localDatabasePort,
    user: credentials.user,
    password: credentials.password,
    authMethod: "scram-sha-256",
    persistent: true,
    postgresFlags: [
      "-c",
      "listen_addresses=127.0.0.1",
      "-c",
      "max_connections=32",
    ],
    onLog: (message) => {
      if (config.logLevel === "debug") {
        const line = String(message).trim();
        if (line) console.log(`[database:local] ${line}`);
      }
    },
    onError: (error) => console.error("[database:local]", error),
  });

  try {
    await readFile(resolve(data, "PG_VERSION"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    console.log("[database] Initializing SOL local PostgreSQL");
    await postgres.initialise();
  }

  await postgres.start();
  await ensureDatabase(postgres, credentials.database);

  const connectionString = localConnectionString(credentials);
  console.log(`[database] SOL local PostgreSQL ready on 127.0.0.1:${config.localDatabasePort}`);

  return {
    connectionString,
    managed: true,
    stop: async () => {
      await postgres.stop().catch((error) => {
        console.error("[database] Could not stop local PostgreSQL cleanly", error);
      });
    },
  };
}

async function startLocalPostgres(): Promise<LocalPostgresRuntime> {
  if (config.localDatabaseUrl) {
    return {
      connectionString: config.localDatabaseUrl,
      managed: false,
      stop: async () => undefined,
    };
  }

  return startManagedLocalPostgres();
}

export function localPostgres(): Promise<LocalPostgresRuntime> {
  runtimePromise ??= startLocalPostgres();
  return runtimePromise;
}
