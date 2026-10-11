import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { Client } from "pg";
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
const postgresLogPath = resolve(runtimeDir, "postgres.log");
const require = createRequire(import.meta.url);

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

function windowsPgCtlPath(): string {
  const embeddedEntry = require.resolve("embedded-postgres");
  const embeddedPackageRoot = resolve(dirname(embeddedEntry), "..");
  return resolve(
    embeddedPackageRoot,
    "..",
    "@embedded-postgres",
    "windows-x64",
    "native",
    "bin",
    "pg_ctl.exe",
  );
}

async function runProcess(
  executable: string,
  args: string[],
  options: { allowExitCodes?: number[]; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const allowExitCodes = options.allowExitCodes ?? [0];
  const timeoutMs = options.timeoutMs ?? 30_000;

  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout?.destroy();
      child.stderr?.destroy();

      const exitCode = code ?? -1;
      if (allowExitCodes.includes(exitCode)) {
        resolvePromise({ code: exitCode, stdout, stderr });
        return;
      }
      const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      rejectPromise(
        new Error(
          `Embedded PostgreSQL command failed (exit ${exitCode}): ${executable} ${args.join(" ")}${detail ? `\n${detail}` : ""}`,
        ),
      );
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.kill();
      rejectPromise(
        new Error(
          `Embedded PostgreSQL command timed out after ${timeoutMs} ms: ${executable} ${args.join(" ")}`,
        ),
      );
    }, timeoutMs);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout?.destroy();
      child.stderr?.destroy();
      rejectPromise(error);
    });

    // On Windows pg_ctl can exit successfully while postgres.exe keeps inherited
    // stdio handles open. Waiting for "close" can therefore deadlock SOL startup.
    // The "exit" event reflects the pg_ctl process lifecycle itself.
    child.on("exit", finish);
  });
}

async function startWindowsPostgres(state: LocalPostgresState): Promise<() => Promise<void>> {
  const pgCtl = windowsPgCtlPath();
  await access(pgCtl);

  const status = await runProcess(pgCtl, ["status", "-D", clusterDir], {
    allowExitCodes: [0, 3, 4],
  });

  if (status.code === 0) {
    console.log(`[database] Embedded PostgreSQL already running on 127.0.0.1:${state.port}`);
  } else {
    console.log("[database] Starting embedded PostgreSQL through pg_ctl");
    await runProcess(
      pgCtl,
      [
        "start",
        "-w",
        "-D",
        clusterDir,
        "-l",
        postgresLogPath,
        "-o",
        `-p ${state.port} -h 127.0.0.1`,
      ],
      {
        env: {
          LC_MESSAGES: "C",
          PGHOST: "127.0.0.1",
          PGPORT: String(state.port),
        },
      },
    );
  }

  // The embedded cluster is shared by SOL Core, MCP bridges, and short-lived
  // administrative commands. A process that didn't start PostgreSQL must never
  // stop it, and even the starter may exit while other clients still need it.
  // Keep the persistent Windows cluster running until an explicit maintenance
  // shutdown. A subsequent SOL startup reuses it via the pg_ctl status check.
  return async () => {
    console.log("[database] Leaving shared embedded PostgreSQL running on Windows");
  };
}

async function ensureSolDatabase(state: LocalPostgresState): Promise<void> {
  const client = new Client({
    host: "127.0.0.1",
    port: state.port,
    user: "sol_local",
    password: state.password,
    database: "postgres",
  });

  await client.connect();
  try {
    const existing = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
      ["sol"],
    );
    if (!existing.rows[0]?.exists) {
      await client.query('CREATE DATABASE "sol"');
      console.log("[database] Created local SOL database");
    }
  } finally {
    await client.end();
  }
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

  let stop: () => Promise<void>;
  if (process.platform === "win32") {
    stop = await startWindowsPostgres(state);
  } else {
    await postgres.start();
    stop = async () => {
      await postgres.stop().catch(() => undefined);
    };
  }

  await ensureSolDatabase(state);

  const password = encodeURIComponent(state.password);
  const connectionString = `postgresql://sol_local:${password}@127.0.0.1:${state.port}/sol`;
  console.log(`[database] Embedded PostgreSQL ready on 127.0.0.1:${state.port}`);

  return {
    connectionString,
    stop,
  };
}

// Only SOL Core starts this watchdog. Auxiliary MCP/CLI processes must not
// supervise or shut down the shared, persistent Windows database.
let watchdogTimer: NodeJS.Timeout | undefined;
let watchdogChecking = false;

export function startLocalPostgresWatchdog(): void {
  if (process.platform !== "win32" || config.databaseMode !== "hybrid" || watchdogTimer) return;

  watchdogTimer = setInterval(() => {
    if (watchdogChecking) return;
    watchdogChecking = true;
    void (async () => {
      try {
        const state = await loadOrCreateState();
        const pgCtl = windowsPgCtlPath();
        const result = await runProcess(pgCtl, ["status", "-D", clusterDir], {
          allowExitCodes: [0, 3, 4],
          timeoutMs: 10_000,
        });
        if (result.code !== 0) {
          console.warn("[database] Shared PostgreSQL stopped; attempting recovery");
          await startWindowsPostgres(state);
          await ensureSolDatabase(state);
          console.log("[database] Shared PostgreSQL automatically recovered");
        }
      } catch (error) {
        console.error("[database] PostgreSQL watchdog recovery failed", error);
      } finally {
        watchdogChecking = false;
      }
    })();
  }, 30_000);
  watchdogTimer.unref();
}

export function stopLocalPostgresWatchdog(): void {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = undefined;
}

export function ensureLocalPostgres(): Promise<LocalPostgresRuntime> {
  runtimePromise ??= startLocalPostgres();
  return runtimePromise;
}
