import { homeAssistantWebSocketUrl, type HomeAssistantState } from "./client.js";
import { ingestHomeAssistantStateChange } from "./ingest.js";
import {
  getHomeAssistantAccount,
  listConfiguredHomeAssistantAccountIds,
  listSelectedHomeAssistantEntities,
  loadHomeAssistantCredential,
  markHomeAssistantConnected,
  markHomeAssistantError,
  type HomeAssistantEntity,
} from "./repository.js";

export type HomeAssistantRuntimeState = "idle" | "connecting" | "open" | "reconnecting" | "error";

export interface HomeAssistantRuntimeStatus {
  sourceAccountId: string;
  state: HomeAssistantRuntimeState;
  haVersion?: string;
  selectedEntities: number;
  reconnectAttempt: number;
  lastError?: string;
  updatedAt: string;
}

interface MessageEventLike { data: unknown }
interface CloseEventLike { code?: number; reason?: string }
interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
  addEventListener(type: "close", listener: (event: CloseEventLike) => void): void;
  addEventListener(type: "error", listener: () => void): void;
}

type WebSocketConstructor = new (url: string) => WebSocketLike;

interface RuntimeSession {
  sourceAccountId: string;
  householdId: string;
  socket?: WebSocketLike;
  state: HomeAssistantRuntimeState;
  haVersion?: string;
  reconnectAttempt: number;
  lastError?: string;
  updatedAt: Date;
  manualStop: boolean;
  generation: number;
  reconnectTimer?: NodeJS.Timeout;
  selected: Map<string, HomeAssistantEntity>;
  ingestChain: Promise<void>;
}

function websocketConstructor(): WebSocketConstructor {
  const ctor = (globalThis as unknown as { WebSocket?: WebSocketConstructor }).WebSocket;
  if (!ctor) throw new Error("This Node.js runtime does not provide a WebSocket client; Node 22+ is required");
  return ctor;
}

function asText(data: unknown): Promise<string> | string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  return String(data ?? "");
}

function stateObject(value: unknown): HomeAssistantState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<HomeAssistantState>;
  if (typeof state.entity_id !== "string" || typeof state.state !== "string") return null;
  return {
    entity_id: state.entity_id,
    state: state.state,
    attributes: state.attributes && typeof state.attributes === "object" ? state.attributes : {},
    last_changed: typeof state.last_changed === "string" ? state.last_changed : new Date().toISOString(),
    last_updated: typeof state.last_updated === "string" ? state.last_updated : new Date().toISOString(),
    context: state.context && typeof state.context === "object" ? state.context : undefined,
  };
}

function status(runtime: RuntimeSession): HomeAssistantRuntimeStatus {
  return {
    sourceAccountId: runtime.sourceAccountId,
    state: runtime.state,
    haVersion: runtime.haVersion,
    selectedEntities: runtime.selected.size,
    reconnectAttempt: runtime.reconnectAttempt,
    lastError: runtime.lastError,
    updatedAt: runtime.updatedAt.toISOString(),
  };
}

export class HomeAssistantManager {
  private readonly sessions = new Map<string, RuntimeSession>();

  getStatus(sourceAccountId: string): HomeAssistantRuntimeStatus {
    const runtime = this.sessions.get(sourceAccountId);
    return runtime
      ? status(runtime)
      : {
          sourceAccountId,
          state: "idle",
          selectedEntities: 0,
          reconnectAttempt: 0,
          updatedAt: new Date().toISOString(),
        };
  }

  async startConfiguredAccounts(): Promise<void> {
    const ids = await listConfiguredHomeAssistantAccountIds();
    await Promise.all(ids.map((id) => this.start(id).catch((error) => {
      console.error(`[home-assistant:${id}] autostart failed`, error);
    })));
  }

  async refreshSelections(sourceAccountId: string): Promise<void> {
    const runtime = this.sessions.get(sourceAccountId);
    if (!runtime) return;
    const selected = await listSelectedHomeAssistantEntities(sourceAccountId);
    runtime.selected = new Map(selected.map((entity) => [entity.entityId, entity]));
    runtime.updatedAt = new Date();
  }

  async start(sourceAccountId: string): Promise<HomeAssistantRuntimeStatus> {
    const account = await getHomeAssistantAccount(sourceAccountId);
    if (!account) throw new Error("Home Assistant source account not found");
    let runtime = this.sessions.get(sourceAccountId);
    if (!runtime) {
      const selected = await listSelectedHomeAssistantEntities(sourceAccountId);
      runtime = {
        sourceAccountId,
        householdId: account.householdId,
        state: "idle",
        reconnectAttempt: 0,
        updatedAt: new Date(),
        manualStop: false,
        generation: 0,
        selected: new Map(selected.map((entity) => [entity.entityId, entity])),
        ingestChain: Promise.resolve(),
      };
      this.sessions.set(sourceAccountId, runtime);
    }
    runtime.manualStop = false;
    if (runtime.socket && ["connecting", "open", "reconnecting"].includes(runtime.state)) return status(runtime);
    await this.connect(runtime);
    return status(runtime);
  }

  async restart(sourceAccountId: string): Promise<HomeAssistantRuntimeStatus> {
    const runtime = this.sessions.get(sourceAccountId);
    if (runtime) this.closeRuntime(runtime, false);
    return this.start(sourceAccountId);
  }

  async stopAll(): Promise<void> {
    for (const runtime of this.sessions.values()) this.closeRuntime(runtime, true);
    await Promise.all([...this.sessions.values()].map((runtime) => runtime.ingestChain.catch(() => undefined)));
    this.sessions.clear();
  }

  private async connect(runtime: RuntimeSession): Promise<void> {
    const credential = await loadHomeAssistantCredential(runtime.sourceAccountId);
    if (!credential) throw new Error("Home Assistant credentials are missing");
    const WebSocketClient = websocketConstructor();
    runtime.generation += 1;
    const generation = runtime.generation;
    runtime.state = runtime.reconnectAttempt ? "reconnecting" : "connecting";
    runtime.lastError = undefined;
    runtime.updatedAt = new Date();
    const socket = new WebSocketClient(homeAssistantWebSocketUrl(credential.baseUrl));
    runtime.socket = socket;
    let authenticated = false;
    let subscribed = false;
    let nextId = 1;

    socket.addEventListener("message", (event) => {
      void Promise.resolve(asText(event.data)).then((text) => {
        if (runtime.generation !== generation) return;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(text) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = typeof message.type === "string" ? message.type : "";
        if (type === "auth_required") {
          socket.send(JSON.stringify({ type: "auth", access_token: credential.token }));
          return;
        }
        if (type === "auth_invalid") {
          runtime.state = "error";
          runtime.lastError = typeof message.message === "string" ? message.message : "Home Assistant authentication failed";
          runtime.updatedAt = new Date();
          void markHomeAssistantError(runtime.sourceAccountId, runtime.lastError);
          runtime.manualStop = true;
          socket.close(4001, "auth_invalid");
          return;
        }
        if (type === "auth_ok") {
          authenticated = true;
          runtime.haVersion = typeof message.ha_version === "string" ? message.ha_version : runtime.haVersion;
          socket.send(JSON.stringify({ id: nextId++, type: "subscribe_events", event_type: "state_changed" }));
          return;
        }
        if (type === "result" && authenticated && message.success === true && !subscribed) {
          subscribed = true;
          runtime.state = "open";
          runtime.reconnectAttempt = 0;
          runtime.lastError = undefined;
          runtime.updatedAt = new Date();
          void markHomeAssistantConnected(runtime.sourceAccountId, runtime.haVersion).catch((error) =>
            console.error(`[home-assistant:${runtime.sourceAccountId}] status update failed`, error),
          );
          return;
        }
        if (type !== "event" || !subscribed) return;
        const eventObject = message.event;
        if (!eventObject || typeof eventObject !== "object") return;
        const haEvent = eventObject as {
          event_type?: unknown;
          time_fired?: unknown;
          data?: unknown;
        };
        if (haEvent.event_type !== "state_changed" || !haEvent.data || typeof haEvent.data !== "object") return;
        const data = haEvent.data as { entity_id?: unknown; old_state?: unknown; new_state?: unknown };
        if (typeof data.entity_id !== "string") return;
        const selected = runtime.selected.get(data.entity_id);
        if (!selected) return;
        const newState = stateObject(data.new_state);
        if (!newState) return;
        const oldState = stateObject(data.old_state);
        const timeFired = typeof haEvent.time_fired === "string" ? haEvent.time_fired : new Date().toISOString();
        runtime.ingestChain = runtime.ingestChain
          .then(() => ingestHomeAssistantStateChange({
            householdId: runtime.householdId,
            sourceAccountId: runtime.sourceAccountId,
            entity: selected,
            oldState,
            newState,
            timeFired,
          }))
          .then(() => undefined)
          .catch((error) => {
            console.error(`[home-assistant:${runtime.sourceAccountId}] ingest failed`, error);
          });
      }).catch((error) => console.error(`[home-assistant:${runtime.sourceAccountId}] message decode failed`, error));
    });

    socket.addEventListener("close", (event) => {
      if (runtime.generation !== generation) return;
      runtime.socket = undefined;
      runtime.updatedAt = new Date();
      if (runtime.manualStop) {
        if (runtime.state !== "error") runtime.state = "idle";
        return;
      }
      runtime.reconnectAttempt += 1;
      runtime.state = "reconnecting";
      runtime.lastError = event.reason || `WebSocket closed (${event.code ?? "unknown"})`;
      void markHomeAssistantError(runtime.sourceAccountId, runtime.lastError).catch(() => undefined);
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(runtime.reconnectAttempt - 1, 5));
      if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
      runtime.reconnectTimer = setTimeout(() => {
        runtime.reconnectTimer = undefined;
        void this.connect(runtime).catch((error) => {
          runtime.state = "error";
          runtime.lastError = error instanceof Error ? error.message : String(error);
          runtime.updatedAt = new Date();
        });
      }, delay);
      runtime.reconnectTimer.unref();
    });

    socket.addEventListener("error", () => {
      if (runtime.generation !== generation || runtime.manualStop) return;
      runtime.lastError = "Home Assistant WebSocket error";
      runtime.updatedAt = new Date();
    });
  }

  private closeRuntime(runtime: RuntimeSession, manualStop: boolean): void {
    runtime.manualStop = manualStop;
    runtime.generation += 1;
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    runtime.reconnectTimer = undefined;
    try {
      runtime.socket?.close(1000, "SOL connector stopped");
    } catch {
      // best effort
    }
    runtime.socket = undefined;
    runtime.state = "idle";
    runtime.updatedAt = new Date();
  }
}

export const homeAssistantManager = new HomeAssistantManager();
