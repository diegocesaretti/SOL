import pg from "pg";
import { config } from "../config.js";
import { wakeOutbox } from "../core/outbox-wakeup.js";
import { localPostgres } from "./local-postgres.js";
import { normalizePostgresConnectionString } from "./postgres-url.js";

const { Client, Pool } = pg;

const localRuntime = await localPostgres();
const localConnectionString = normalizePostgresConnectionString(localRuntime.connectionString);

export const db = new Pool({
  connectionString: localConnectionString,
  max: config.databasePoolMax,
  idleTimeoutMillis: config.databaseIdleTimeoutMs,
  connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
});

db.on("error", (error) => {
  console.error("[database] idle local PostgreSQL pool connection failed", error);
});

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
    connectionString: localConnectionString,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
  });
  outboxListener = client;

  let disconnected = false;
  const handleDisconnect = (error?: Error): void => {
    if (disconnected) return;
    disconnected = true;

    if (outboxListener === client) outboxListener = undefined;
    if (error) {
      console.error("[database] SOL local outbox listener connection failed", error);
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
    console.log("[database] SOL local outbox listener connected");
    wakeOutbox();
  } catch (error) {
    if (outboxListener === client) outboxListener = undefined;
    console.error("[database] Could not enable local SOL outbox notifications", error);
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

export async function closeDatabase(): Promise<void> {
  outboxListenerStopped = true;

  if (outboxListenerReconnectTimer) {
    clearTimeout(outboxListenerReconnectTimer);
    outboxListenerReconnectTimer = undefined;
  }

  const listener = outboxListener;
  outboxListener = undefined;
  if (listener) await listener.end().catch(() => undefined);

  await db.end();
  await localRuntime.stop();
}
