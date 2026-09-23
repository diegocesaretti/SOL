import pg from "pg";
import { config } from "../config.js";
import { wakeOutbox } from "../core/outbox-wakeup.js";
import { ensureLocalPostgres } from "./local-postgres.js";
import {
  directPostgresConnectionString,
  normalizePostgresConnectionString,
} from "./postgres-url.js";

const { Client, Pool } = pg;

export const databaseRuntimeMode = config.databaseMode;

const localRuntime = databaseRuntimeMode === "hybrid"
  ? await ensureLocalPostgres()
  : undefined;

const activeConnectionString = normalizePostgresConnectionString(
  localRuntime?.connectionString ?? config.databaseUrl,
);

export const db = new Pool({
  connectionString: activeConnectionString,
  max: config.databasePoolMax,
  idleTimeoutMillis: config.databaseIdleTimeoutMs,
  connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
});

export const cloudDb = databaseRuntimeMode === "hybrid"
  ? new Pool({
      connectionString: normalizePostgresConnectionString(config.databaseUrl),
      max: Math.min(2, config.databasePoolMax),
      idleTimeoutMillis: config.databaseIdleTimeoutMs,
      connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
    })
  : undefined;

db.on("error", (error) => {
  console.error("[database] idle PostgreSQL pool connection failed", error);
});
cloudDb?.on("error", (error) => {
  console.error("[database] idle cloud PostgreSQL pool connection failed", error);
});

const listenerConnectionString = databaseRuntimeMode === "hybrid"
  ? activeConnectionString
  : normalizePostgresConnectionString(
      config.databaseListenUrl ?? directPostgresConnectionString(config.databaseUrl),
    );

const LISTENER_RECONNECT_MIN_MS = 1_000;
const LISTENER_RECONNECT_MAX_MS = 30_000;

let outboxListener: InstanceType<typeof Client> | undefined;
let outboxListenerReconnectTimer: NodeJS.Timeout | undefined;
let outboxListenerReconnectDelayMs = LISTENER_RECONNECT_MIN_MS;
let outboxListenerStopped = false;

function scheduleOutboxListenerReconnect(): void {
  if (outboxListenerStopped || outboxListenerReconnectTimer) return;

  const delay = outboxListenerReconnectDelayMs;
  outboxListenerReconnectDelayMs = Math.min(
    outboxListenerReconnectDelayMs * 2,
    LISTENER_RECONNECT_MAX_MS,
  );

  outboxListenerReconnectTimer = setTimeout(() => {
    outboxListenerReconnectTimer = undefined;
    void connectOutboxListener();
  }, delay);
  outboxListenerReconnectTimer.unref();
}

async function connectOutboxListener(): Promise<void> {
  if (outboxListenerStopped || outboxListener) return;

  const client = new Client({
    connectionString: listenerConnectionString,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
  });
  outboxListener = client;

  let disconnected = false;
  const handleDisconnect = (error?: Error): void => {
    if (disconnected) return;
    disconnected = true;

    if (outboxListener === client) outboxListener = undefined;
    if (error) {
      console.error("[database] SOL outbox listener connection failed", error);
    }

    if (!outboxListenerStopped) scheduleOutboxListenerReconnect();
  };

  client.on("notification", (message) => {
    if (message.channel === "sol_outbox") wakeOutbox();
  });
  client.on("error", (error) => handleDisconnect(error));
  client.on("end", () => handleDisconnect());

  try {
    await client.connect();

    if (outboxListenerStopped) {
      await client.end().catch(() => undefined);
      return;
    }

    await client.query("LISTEN sol_outbox");
    outboxListenerReconnectDelayMs = LISTENER_RECONNECT_MIN_MS;
    console.log(
      `[database] SOL outbox listener connected (${databaseRuntimeMode === "hybrid" ? "local" : "primary"})`,
    );
    wakeOutbox();
  } catch (error) {
    if (outboxListener === client) outboxListener = undefined;
    console.error("[database] Could not enable SOL outbox notifications", error);
    await client.end().catch(() => undefined);
    scheduleOutboxListenerReconnect();
  }
}

void connectOutboxListener();

export async function checkDatabase(): Promise<boolean> {
  try {
    await db.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function checkCloudDatabase(): Promise<boolean | null> {
  if (!cloudDb) return null;
  try {
    await cloudDb.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  outboxListenerStopped = true;

  if (outboxListenerReconnectTimer) {
    clearTimeout(outboxListenerReconnectTimer);
    outboxListenerReconnectTimer = undefined;
  }

  const listener = outboxListener;
  outboxListener = undefined;
  if (listener) await listener.end().catch(() => undefined);

  await cloudDb?.end().catch(() => undefined);
  await db.end();
  await localRuntime?.stop();
}
