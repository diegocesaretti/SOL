import makeWASocket, {
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} from "baileys";
import pino from "pino";
import * as QRCode from "qrcode";
import { createWhatsappAuthState, clearWhatsappAuthState } from "./auth-store.js";
import {
  ingestWhatsappMessage,
  updateWhatsappConversationTitles,
} from "./ingest.js";
import {
  clearWhatsappLinkState,
  ensureWhatsappSessionRecord,
  getWhatsappAccount,
  listWhatsappAutostartAccounts,
  markWhatsappConnected,
  markWhatsappDisconnected,
  markWhatsappHistoryComplete,
} from "./repository.js";

export type WhatsappRuntimeState =
  | "idle"
  | "connecting"
  | "qr"
  | "open"
  | "reconnecting"
  | "error"
  | "logged_out";

export interface WhatsappRuntimeStatus {
  sourceAccountId: string;
  state: WhatsappRuntimeState;
  qrDataUrl?: string;
  pairingCode?: string;
  phoneJid?: string;
  displayName?: string;
  lastError?: string;
  reconnectAttempt: number;
  updatedAt: string;
}

type Socket = ReturnType<typeof makeWASocket>;

interface RuntimeSession {
  sourceAccountId: string;
  socket?: Socket;
  state: WhatsappRuntimeState;
  qrDataUrl?: string;
  pairingCode?: string;
  phoneJid?: string;
  displayName?: string;
  lastError?: string;
  reconnectAttempt: number;
  updatedAt: Date;
  manualStop: boolean;
  generation: number;
  startPromise?: Promise<void>;
  reconnectTimer?: NodeJS.Timeout;
  ingestChain: Promise<void>;
  authSaveChain: Promise<void>;
}

const logger = pino({ level: "silent" });
const NON_RECONNECTABLE = new Set<number>([
  DisconnectReason.loggedOut,
  DisconnectReason.badSession,
  DisconnectReason.connectionReplaced,
  DisconnectReason.forbidden,
  DisconnectReason.multideviceMismatch,
]);

function disconnectStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as {
    output?: { statusCode?: number };
    statusCode?: number;
  };
  return value.output?.statusCode ?? value.statusCode;
}

function disconnectMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return undefined;
}

function publicStatus(runtime: RuntimeSession): WhatsappRuntimeStatus {
  return {
    sourceAccountId: runtime.sourceAccountId,
    state: runtime.state,
    qrDataUrl: runtime.qrDataUrl,
    pairingCode: runtime.pairingCode,
    phoneJid: runtime.phoneJid,
    displayName: runtime.displayName,
    lastError: runtime.lastError,
    reconnectAttempt: runtime.reconnectAttempt,
    updatedAt: runtime.updatedAt.toISOString(),
  };
}

export class WhatsappManager {
  private readonly sessions = new Map<string, RuntimeSession>();

  getStatus(sourceAccountId: string): WhatsappRuntimeStatus {
    const runtime = this.sessions.get(sourceAccountId);
    if (!runtime) {
      return {
        sourceAccountId,
        state: "idle",
        reconnectAttempt: 0,
        updatedAt: new Date().toISOString(),
      };
    }
    return publicStatus(runtime);
  }

  async startLinkedAccounts(): Promise<void> {
    const accountIds = await listWhatsappAutostartAccounts();
    await Promise.all(
      accountIds.map((accountId) =>
        this.start(accountId).catch((error) => {
          console.error(`[whatsapp:${accountId}] autostart failed`, error);
        }),
      ),
    );
  }

  async start(sourceAccountId: string): Promise<WhatsappRuntimeStatus> {
    let runtime = this.sessions.get(sourceAccountId);
    if (!runtime) {
      runtime = {
        sourceAccountId,
        state: "idle",
        reconnectAttempt: 0,
        updatedAt: new Date(),
        manualStop: false,
        generation: 0,
        ingestChain: Promise.resolve(),
        authSaveChain: Promise.resolve(),
      };
      this.sessions.set(sourceAccountId, runtime);
    }

    runtime.manualStop = false;
    if (runtime.startPromise) await runtime.startPromise;
    if (
      runtime.socket &&
      ["connecting", "qr", "open", "reconnecting"].includes(runtime.state)
    ) {
      return publicStatus(runtime);
    }

    runtime.startPromise = this.connect(runtime).finally(() => {
      runtime!.startPromise = undefined;
    });
    await runtime.startPromise;
    return publicStatus(runtime);
  }

  async requestPairingCode(
    sourceAccountId: string,
    phoneNumber: string,
  ): Promise<WhatsappRuntimeStatus> {
    const digits = phoneNumber.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 16) {
      throw new Error("Use the full phone number including country code, digits only");
    }

    await this.start(sourceAccountId);
    const runtime = this.sessions.get(sourceAccountId);
    if (!runtime?.socket) throw new Error("WhatsApp socket is not ready");
    if (runtime.socket.authState.creds.registered) {
      throw new Error("This WhatsApp account is already linked");
    }

    const code = await runtime.socket.requestPairingCode(digits);
    runtime.pairingCode = code;
    runtime.state = "qr";
    runtime.updatedAt = new Date();
    return publicStatus(runtime);
  }

  async restart(sourceAccountId: string): Promise<WhatsappRuntimeStatus> {
    const runtime = this.sessions.get(sourceAccountId);
    if (runtime) await this.stopRuntime(runtime, false);
    return this.start(sourceAccountId);
  }

  async logout(sourceAccountId: string): Promise<void> {
    const runtime = this.sessions.get(sourceAccountId);
    if (runtime) {
      runtime.manualStop = true;
      if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
      runtime.reconnectTimer = undefined;
      try {
        await runtime.socket?.logout("SOL account unlink");
      } catch {
        // Credentials are explicitly cleared below even if WhatsApp is unreachable.
      }
      this.closeSocket(runtime.socket);
      await runtime.authSaveChain.catch(() => undefined);
      this.sessions.delete(sourceAccountId);
    }

    await clearWhatsappAuthState(sourceAccountId);
    await clearWhatsappLinkState(sourceAccountId);
  }

  async stopAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    await Promise.all(sessions.map((runtime) => this.stopRuntime(runtime, true)));
    this.sessions.clear();
  }

  private async connect(runtime: RuntimeSession): Promise<void> {
    await ensureWhatsappSessionRecord(runtime.sourceAccountId);
    const account = await getWhatsappAccount(runtime.sourceAccountId);
    if (!account) throw new Error("WhatsApp source account not found");
    if (!account.enabled) throw new Error("WhatsApp source account is disabled");

    await runtime.authSaveChain;
    runtime.generation += 1;
    const generation = runtime.generation;
    runtime.state = runtime.reconnectAttempt > 0 ? "reconnecting" : "connecting";
    runtime.qrDataUrl = undefined;
    runtime.pairingCode = undefined;
    runtime.lastError = undefined;
    runtime.updatedAt = new Date();

    const { state, saveCreds } = await createWhatsappAuthState(runtime.sourceAccountId);
    const socket = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      browser: Browsers.windows("SOL"),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      emitOwnEvents: true,
    });
    runtime.socket = socket;

    socket.ev.on("creds.update", () => {
      runtime.authSaveChain = runtime.authSaveChain
        .then(saveCreds)
        .catch((error) => {
          runtime.lastError = `Failed to persist WhatsApp credentials: ${
            error instanceof Error ? error.message : String(error)
          }`;
          runtime.updatedAt = new Date();
          console.error(`[whatsapp:${runtime.sourceAccountId}] save creds failed`, error);
          throw error;
        });
    });

    socket.ev.on("connection.update", (update) => {
      if (runtime.generation !== generation) return;

      if (update.qr) {
        void QRCode.toDataURL(update.qr, {
          width: 320,
          margin: 1,
          errorCorrectionLevel: "M",
        })
          .then((dataUrl) => {
            if (runtime.generation !== generation) return;
            runtime.qrDataUrl = dataUrl;
            runtime.state = "qr";
            runtime.updatedAt = new Date();
          })
          .catch((error) => {
            runtime.lastError = `QR generation failed: ${String(error)}`;
            runtime.updatedAt = new Date();
          });
      }

      if (update.connection === "open") {
        runtime.state = "open";
        runtime.qrDataUrl = undefined;
        runtime.pairingCode = undefined;
        runtime.reconnectAttempt = 0;
        runtime.lastError = undefined;
        runtime.phoneJid = socket.user?.id;
        runtime.displayName = socket.user?.name ?? undefined;
        runtime.updatedAt = new Date();
        void markWhatsappConnected(runtime.sourceAccountId, {
          id: socket.user?.id,
          name: socket.user?.name,
        }).catch((error) =>
          console.error(`[whatsapp:${runtime.sourceAccountId}] state update failed`, error),
        );
      }

      if (update.connection === "close") {
        void this.handleClose(runtime, generation, update.lastDisconnect?.error);
      }
    });

    socket.ev.on("messages.upsert", (upsert) => {
      const origin = upsert.type === "notify" ? "realtime" : "history";
      this.enqueue(runtime, async () => {
        const currentAccount = await getWhatsappAccount(runtime.sourceAccountId);
        if (!currentAccount) return;
        for (const message of upsert.messages) {
          await ingestWhatsappMessage(
            currentAccount,
            message,
            origin,
            socket.user?.id,
            upsert.type,
          );
        }
      });
    });

    socket.ev.on("messaging-history.set", (history) => {
      this.enqueue(runtime, async () => {
        const currentAccount = await getWhatsappAccount(runtime.sourceAccountId);
        if (!currentAccount) return;

        await updateWhatsappConversationTitles(
          runtime.sourceAccountId,
          history.chats.map((chat) => ({
            id: chat.id,
            name: (chat as { name?: string | null }).name,
          })),
        );

        for (const message of history.messages) {
          await ingestWhatsappMessage(
            currentAccount,
            message,
            "history",
            socket.user?.id,
            "history-set",
          );
        }

        if (history.isLatest || history.progress === 100) {
          await markWhatsappHistoryComplete(runtime.sourceAccountId);
        }
      });
    });

    socket.ev.on("messaging-history.status", (historyStatus) => {
      if (historyStatus.status === "complete") {
        void markWhatsappHistoryComplete(runtime.sourceAccountId).catch((error) =>
          console.error(`[whatsapp:${runtime.sourceAccountId}] history status failed`, error),
        );
      }
    });

    socket.ev.on("chats.upsert", (chats) => {
      this.enqueue(runtime, () =>
        updateWhatsappConversationTitles(
          runtime.sourceAccountId,
          chats.map((chat) => ({
            id: chat.id,
            name: (chat as { name?: string | null }).name,
          })),
        ),
      );
    });

    socket.ev.on("chats.update", (chats) => {
      this.enqueue(runtime, () =>
        updateWhatsappConversationTitles(
          runtime.sourceAccountId,
          chats.map((chat) => ({
            id: chat.id,
            name: (chat as { name?: string | null }).name,
          })),
        ),
      );
    });
  }

  private enqueue(runtime: RuntimeSession, job: () => Promise<void>): void {
    runtime.ingestChain = runtime.ingestChain
      .then(job)
      .catch((error) => {
        console.error(`[whatsapp:${runtime.sourceAccountId}] ingest failed`, error);
      });
  }

  private async handleClose(
    runtime: RuntimeSession,
    generation: number,
    error: unknown,
  ): Promise<void> {
    if (runtime.generation !== generation) return;
    runtime.socket = undefined;
    runtime.qrDataUrl = undefined;
    runtime.pairingCode = undefined;
    runtime.updatedAt = new Date();

    if (runtime.manualStop) {
      runtime.state = "idle";
      return;
    }

    const statusCode = disconnectStatusCode(error);
    const message = disconnectMessage(error);

    if (statusCode !== undefined && NON_RECONNECTABLE.has(statusCode)) {
      runtime.lastError = message ?? `WhatsApp disconnected (${statusCode})`;
      runtime.state = statusCode === DisconnectReason.loggedOut ? "logged_out" : "error";
      await markWhatsappDisconnected(runtime.sourceAccountId, runtime.lastError);

      if (
        statusCode === DisconnectReason.loggedOut ||
        statusCode === DisconnectReason.badSession
      ) {
        await runtime.authSaveChain.catch(() => undefined);
        await clearWhatsappAuthState(runtime.sourceAccountId).catch(() => undefined);
        await clearWhatsappLinkState(runtime.sourceAccountId).catch(() => undefined);
      }
      return;
    }

    runtime.reconnectAttempt += 1;
    runtime.state = "reconnecting";
    runtime.lastError = message;
    await markWhatsappDisconnected(runtime.sourceAccountId, message);

    const delayMs =
      statusCode === DisconnectReason.restartRequired
        ? 250
        : Math.min(30_000, 1_000 * 2 ** Math.min(runtime.reconnectAttempt - 1, 5));

    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    runtime.reconnectTimer = setTimeout(() => {
      runtime.reconnectTimer = undefined;
      runtime.startPromise = runtime.authSaveChain
        .catch(() => undefined)
        .then(() => this.connect(runtime))
        .finally(() => {
          runtime.startPromise = undefined;
        });
      void runtime.startPromise.catch((reconnectError) => {
        runtime.state = "error";
        runtime.lastError =
          reconnectError instanceof Error ? reconnectError.message : String(reconnectError);
        runtime.updatedAt = new Date();
      });
    }, delayMs);
    runtime.reconnectTimer.unref();
  }

  private async stopRuntime(runtime: RuntimeSession, waitForIngest: boolean): Promise<void> {
    runtime.manualStop = true;
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    runtime.reconnectTimer = undefined;
    this.closeSocket(runtime.socket);
    runtime.socket = undefined;
    runtime.state = "idle";
    runtime.updatedAt = new Date();
    if (waitForIngest) {
      await Promise.all([
        runtime.ingestChain.catch(() => undefined),
        runtime.authSaveChain.catch(() => undefined),
      ]);
    }
  }

  private closeSocket(socket: Socket | undefined): void {
    if (!socket) return;
    const closable = socket as unknown as { end?: (error?: Error) => void };
    try {
      closable.end?.(new Error("SOL WhatsApp connector stopped"));
    } catch {
      // Shutdown is best-effort; logout is a distinct explicit operation.
    }
  }
}

export const whatsappManager = new WhatsappManager();
