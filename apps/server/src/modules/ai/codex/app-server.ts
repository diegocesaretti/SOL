import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

export interface CodexAppServerOptions {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

export interface CodexNotification {
  method: string;
  params?: unknown;
}

export type CodexNotificationHandler = (notification: CodexNotification) => void;

export class CodexAppServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAppServerError";
  }
}

export class CodexAppServerClient {
  private process?: ChildProcessWithoutNullStreams;
  private initialized = false;
  private startPromise?: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<CodexNotificationHandler>();
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: CodexAppServerOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  get running(): boolean {
    return Boolean(this.process && !this.process.killed && this.process.exitCode === null);
  }

  get ready(): boolean {
    return this.running && this.initialized;
  }

  async start(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    if (this.ready) return;

    this.startPromise = this.startProcess().finally(() => {
      this.startPromise = undefined;
    });
    await this.startPromise;
  }

  private async startProcess(): Promise<void> {
    this.initialized = false;
    const child = spawn(this.options.command, ["app-server"], {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;

    child.on("error", (error) => this.handleProcessFailure(error));
    child.on("exit", (code, signal) => {
      if (this.process === child) this.process = undefined;
      this.initialized = false;
      this.rejectAllPending(
        new CodexAppServerError(
          `Codex app-server exited (code=${String(code)}, signal=${String(signal)})`,
        ),
      );
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = String(chunk).trim();
      if (text) console.warn(`[codex] ${text}`);
    });

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));

    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const cleanup = () => {
          child.off("spawn", onSpawn);
          child.off("error", onError);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });

      await this.requestRaw("initialize", {
        clientInfo: {
          name: "sol_core",
          title: "SOL Family Assistant",
          version: "0.2.0",
        },
      });
      this.notifyRaw("initialized", {});
      this.initialized = true;
    } catch (error) {
      this.initialized = false;
      if (this.process === child) this.process = undefined;
      if (!child.killed) child.kill("SIGTERM");
      throw new CodexAppServerError(
        `Unable to initialize '${this.options.command} app-server': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async request<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    await this.start();
    return this.requestRaw<TResult>(method, params);
  }

  private requestRaw<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    const child = this.process;
    if (!child || child.killed || child.exitCode !== null) {
      return Promise.reject(new CodexAppServerError("Codex app-server is not running"));
    }

    const id = this.nextId++;
    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerError(`Codex request timed out: ${method}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private notifyRaw(method: string, params?: unknown): void {
    const child = this.process;
    if (!child || child.killed || child.exitCode !== null) {
      throw new CodexAppServerError("Codex app-server is not running");
    }
    child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  onNotification(handler: CodexNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  async stop(): Promise<void> {
    const child = this.process;
    this.initialized = false;
    this.process = undefined;
    if (!child) return;
    child.kill("SIGTERM");
    this.rejectAllPending(new CodexAppServerError("Codex app-server stopped"));
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      console.warn("Ignoring non-JSON Codex app-server output");
      return;
    }

    if (typeof message.id === "number" && typeof message.method !== "string") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);

      if (message.error && typeof message.error === "object") {
        const error = message.error as { message?: string; code?: number };
        pending.reject(
          new CodexAppServerError(
            `Codex RPC error${error.code ? ` ${error.code}` : ""}: ${
              error.message ?? "unknown error"
            }`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === "string" && typeof message.id !== "number") {
      const notification: CodexNotification = {
        method: message.method,
        params: message.params,
      };
      for (const handler of this.notificationHandlers) {
        try {
          handler(notification);
        } catch (error) {
          console.error("Codex notification handler failed", error);
        }
      }
      return;
    }

    // SOL intentionally does not grant app-server initiated capabilities yet.
    if (typeof message.method === "string" && typeof message.id === "number") {
      this.process?.stdin.write(
        `${JSON.stringify({
          id: message.id,
          error: { code: -32601, message: "SOL client does not support this server request" },
        })}\n`,
      );
    }
  }

  private handleProcessFailure(error: Error): void {
    this.initialized = false;
    this.rejectAllPending(
      new CodexAppServerError(`Codex app-server process error: ${error.message}`),
    );
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
