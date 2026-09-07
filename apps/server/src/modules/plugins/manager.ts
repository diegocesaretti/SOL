import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { extractZipBuffer } from "./zip.js";
import {
  type SolPluginHealth,
  type SolPluginLogEntry,
  type SolPluginManifest,
  type SolPluginProcessState,
  type SolPluginSnapshot,
  validatePluginManifest,
} from "./types.js";

interface PluginManagerOptions {
  rootDir: string;
  coreUrl: string;
  maxPackageBytes?: number;
  logLimit?: number;
}

interface PersistedPluginState {
  enabled: boolean;
}

interface PersistedState {
  plugins: Record<string, PersistedPluginState>;
}

interface ManagedPlugin {
  manifest: SolPluginManifest;
  directory: string;
  enabled: boolean;
  state: SolPluginProcessState;
  health: SolPluginHealth;
  healthDetails?: Record<string, unknown>;
  child?: ChildProcess;
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
  lastExitCode?: number | null;
  lastError?: string;
  logs: SolPluginLogEntry[];
  stdoutTail: string;
  stderrTail: string;
  stopRequested: boolean;
  restartHistory: number[];
  restartTimer?: NodeJS.Timeout;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function healthValue(value: unknown): SolPluginHealth | undefined {
  return value === "healthy" || value === "degraded" || value === "unhealthy" || value === "unknown"
    ? value
    : undefined;
}

function detailsValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isWithin(parent: string, candidate: string): boolean {
  const root = resolve(parent);
  const target = resolve(candidate);
  return target === root || target.startsWith(root + sep);
}

export class PluginManager {
  private readonly rootDir: string;
  private readonly statePath: string;
  private readonly coreUrl: string;
  private readonly maxPackageBytes: number;
  private readonly logLimit: number;
  private readonly plugins = new Map<string, ManagedPlugin>();
  private initialized = false;
  private shuttingDown = false;

  constructor(options: PluginManagerOptions) {
    this.rootDir = resolve(options.rootDir);
    this.statePath = join(this.rootDir, ".plugin-state.json");
    this.coreUrl = options.coreUrl;
    this.maxPackageBytes = options.maxPackageBytes ?? 64 * 1024 * 1024;
    this.logLimit = options.logLimit ?? 400;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.rootDir, { recursive: true });
    const persisted = await this.readState();
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const directory = join(this.rootDir, entry.name);
      try {
        const manifest = await this.readManifest(directory);
        const entryPath = join(directory, ...manifest.entry.split("/"));
        const info = await stat(entryPath);
        if (!info.isFile()) throw new Error("plugin entry is not a file");
        if (this.plugins.has(manifest.id)) throw new Error(`duplicate plugin id ${manifest.id}`);
        this.plugins.set(manifest.id, this.createRecord(
          manifest,
          directory,
          persisted.plugins[manifest.id]?.enabled ?? manifest.autoStart,
        ));
      } catch (error) {
        console.error(`SOL plugin discovery ignored ${entry.name}: ${errorMessage(error)}`);
      }
    }
    this.initialized = true;
    await this.persistState();
  }

  async list(): Promise<SolPluginSnapshot[]> {
    await this.init();
    return [...this.plugins.values()]
      .map((plugin) => this.snapshot(plugin))
      .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name, "es"));
  }

  async get(id: string): Promise<SolPluginSnapshot> {
    await this.init();
    return this.snapshot(this.requirePlugin(id));
  }

  async getLogs(id: string, limit = 200): Promise<SolPluginLogEntry[]> {
    await this.init();
    const plugin = this.requirePlugin(id);
    const bounded = Math.max(1, Math.min(this.logLimit, Math.trunc(limit)));
    return plugin.logs.slice(-bounded);
  }

  async installPackage(buffer: Buffer): Promise<SolPluginSnapshot> {
    await this.init();
    if (!buffer.length) throw new Error("plugin package is empty");
    if (buffer.length > this.maxPackageBytes) throw new Error("plugin package exceeds the configured size limit");

    const temporary = join(this.rootDir, `.install-${randomUUID()}`);
    try {
      extractZipBuffer(buffer, temporary, { maxUncompressedBytes: this.maxPackageBytes * 2 });
      const manifest = await this.readManifest(temporary);
      const entryPath = join(temporary, ...manifest.entry.split("/"));
      if (!isWithin(temporary, entryPath)) throw new Error("plugin entry escapes package directory");
      const info = await stat(entryPath).catch(() => undefined);
      if (!info?.isFile()) throw new Error(`plugin entry does not exist: ${manifest.entry}`);
      if (this.plugins.has(manifest.id)) throw new Error(`plugin_already_installed:${manifest.id}`);

      const destination = join(this.rootDir, manifest.id);
      if (existsSync(destination)) throw new Error(`plugin directory already exists: ${manifest.id}`);
      await rename(temporary, destination);
      const record = this.createRecord(manifest, destination, manifest.autoStart);
      this.plugins.set(manifest.id, record);
      this.appendLog(record, "sol", "info", `Installed ${manifest.name} ${manifest.version}`);
      await this.persistState();
      if (record.enabled) await this.startInternal(record, false);
      return this.snapshot(record);
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async uninstall(id: string): Promise<void> {
    await this.init();
    const plugin = this.requirePlugin(id);
    await this.terminate(plugin, true);
    this.plugins.delete(plugin.manifest.id);
    await rm(plugin.directory, { recursive: true, force: true });
    await this.persistState();
  }

  async start(id: string): Promise<SolPluginSnapshot> {
    await this.init();
    const plugin = this.requirePlugin(id);
    plugin.enabled = true;
    await this.persistState();
    await this.startInternal(plugin, false);
    return this.snapshot(plugin);
  }

  async stop(id: string): Promise<SolPluginSnapshot> {
    await this.init();
    const plugin = this.requirePlugin(id);
    plugin.enabled = false;
    await this.persistState();
    await this.terminate(plugin, true);
    return this.snapshot(plugin);
  }

  async restart(id: string): Promise<SolPluginSnapshot> {
    await this.init();
    const plugin = this.requirePlugin(id);
    plugin.enabled = true;
    await this.persistState();
    await this.terminate(plugin, true);
    await this.startInternal(plugin, false);
    return this.snapshot(plugin);
  }

  async startEnabled(): Promise<void> {
    await this.init();
    for (const plugin of this.plugins.values()) {
      if (!plugin.enabled) continue;
      await this.startInternal(plugin, false).catch((error) => {
        plugin.lastError = errorMessage(error);
        plugin.state = "error";
        this.appendLog(plugin, "sol", "error", `Autostart failed: ${plugin.lastError}`);
      });
    }
  }

  async shutdown(): Promise<void> {
    await this.init();
    this.shuttingDown = true;
    await Promise.all([...this.plugins.values()].map((plugin) => this.terminate(plugin, false).catch(() => undefined)));
  }

  private createRecord(manifest: SolPluginManifest, directory: string, enabled: boolean): ManagedPlugin {
    return {
      manifest,
      directory,
      enabled,
      state: "stopped",
      health: "unknown",
      logs: [],
      stdoutTail: "",
      stderrTail: "",
      stopRequested: false,
      restartHistory: [],
    };
  }

  private async readManifest(directory: string): Promise<SolPluginManifest> {
    const raw = await readFile(join(directory, "sol-plugin.json"), "utf8");
    return validatePluginManifest(JSON.parse(raw) as unknown);
  }

  private async readState(): Promise<PersistedState> {
    try {
      const raw = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<PersistedState>;
      return { plugins: raw.plugins && typeof raw.plugins === "object" ? raw.plugins : {} } as PersistedState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`Could not read plugin state: ${errorMessage(error)}`);
      return { plugins: {} };
    }
  }

  private async persistState(): Promise<void> {
    const state: PersistedState = { plugins: {} };
    for (const plugin of this.plugins.values()) state.plugins[plugin.manifest.id] = { enabled: plugin.enabled };
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", "utf8");
    await rename(temporary, this.statePath);
  }

  private requirePlugin(id: string): ManagedPlugin {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error(`plugin_not_found:${id}`);
    return plugin;
  }

  private snapshot(plugin: ManagedPlugin): SolPluginSnapshot {
    return {
      manifest: plugin.manifest,
      enabled: plugin.enabled,
      state: plugin.state,
      health: plugin.health,
      healthDetails: plugin.healthDetails,
      pid: plugin.pid,
      startedAt: plugin.startedAt,
      stoppedAt: plugin.stoppedAt,
      lastExitCode: plugin.lastExitCode,
      lastError: plugin.lastError,
      lastLogAt: plugin.logs.at(-1)?.at,
    };
  }

  private async startInternal(plugin: ManagedPlugin, automaticRestart: boolean): Promise<void> {
    if (this.shuttingDown) return;
    if (plugin.child && plugin.state !== "stopped" && plugin.state !== "error") return;
    if (plugin.restartTimer) {
      clearTimeout(plugin.restartTimer);
      plugin.restartTimer = undefined;
    }

    const entryPath = join(plugin.directory, ...plugin.manifest.entry.split("/"));
    const command = plugin.manifest.runtime === "node" ? process.execPath : entryPath;
    const args = plugin.manifest.runtime === "node"
      ? [entryPath, ...plugin.manifest.args]
      : [...plugin.manifest.args];

    plugin.state = "starting";
    plugin.health = "unknown";
    plugin.healthDetails = undefined;
    plugin.stopRequested = false;
    plugin.lastError = undefined;
    this.appendLog(plugin, "sol", "info", `${automaticRestart ? "Restarting" : "Starting"} plugin`);

    const child = spawn(command, args, {
      cwd: plugin.directory,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SOL_PLUGIN_ID: plugin.manifest.id,
        SOL_PLUGIN_ROOT: plugin.directory,
        SOL_CORE_URL: this.coreUrl,
      },
    });
    plugin.child = child;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.consumeOutput(plugin, "stdout", chunk));
    child.stderr?.on("data", (chunk: string) => this.consumeOutput(plugin, "stderr", chunk));

    await new Promise<void>((resolveStart, rejectStart) => {
      const onSpawn = () => {
        cleanup();
        if (plugin.child === child) {
          plugin.pid = child.pid;
          plugin.startedAt = new Date().toISOString();
          plugin.stoppedAt = undefined;
          plugin.state = "running";
        }
        resolveStart();
      };
      const onError = (error: Error) => {
        cleanup();
        rejectStart(error);
      };
      const cleanup = () => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    }).catch((error) => {
      plugin.child = undefined;
      plugin.pid = undefined;
      plugin.state = "error";
      plugin.health = "unhealthy";
      plugin.lastError = errorMessage(error);
      this.appendLog(plugin, "sol", "error", `Start failed: ${plugin.lastError}`);
      throw error;
    });

    child.on("error", (error) => {
      if (plugin.child !== child) return;
      plugin.lastError = errorMessage(error);
      plugin.health = "unhealthy";
      this.appendLog(plugin, "sol", "error", `Process error: ${plugin.lastError}`);
    });
    child.once("exit", (code, signal) => this.handleExit(plugin, child, code, signal));
  }

  private handleExit(plugin: ManagedPlugin, child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (plugin.child !== child) return;
    plugin.child = undefined;
    plugin.pid = undefined;
    plugin.lastExitCode = code;
    plugin.stoppedAt = new Date().toISOString();
    plugin.health = "unknown";
    plugin.healthDetails = undefined;
    const requested = plugin.stopRequested || this.shuttingDown;
    plugin.stopRequested = false;
    plugin.state = requested || code === 0 ? "stopped" : "error";
    this.flushTail(plugin, "stdout");
    this.flushTail(plugin, "stderr");
    this.appendLog(plugin, "sol", code === 0 || requested ? "info" : "error", `Process exited (${code ?? signal ?? "unknown"})`);

    if (requested || !plugin.enabled || plugin.manifest.restartPolicy !== "on-failure" || code === 0) return;
    const now = Date.now();
    plugin.restartHistory = plugin.restartHistory.filter((at) => now - at < 60_000);
    if (plugin.restartHistory.length >= 3) {
      plugin.lastError = "Crash loop detected; automatic restart paused after 3 failures in 60 seconds";
      plugin.health = "unhealthy";
      this.appendLog(plugin, "sol", "error", plugin.lastError);
      return;
    }
    plugin.restartHistory.push(now);
    plugin.restartTimer = setTimeout(() => {
      plugin.restartTimer = undefined;
      void this.startInternal(plugin, true).catch(() => undefined);
    }, 1_500);
    plugin.restartTimer.unref?.();
  }

  private async terminate(plugin: ManagedPlugin, requested: boolean): Promise<void> {
    if (plugin.restartTimer) {
      clearTimeout(plugin.restartTimer);
      plugin.restartTimer = undefined;
    }
    const child = plugin.child;
    if (!child) {
      plugin.state = "stopped";
      plugin.health = "unknown";
      plugin.pid = undefined;
      return;
    }
    plugin.stopRequested = requested || this.shuttingDown;
    const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    child.kill("SIGTERM");
    const timeout = new Promise<"timeout">((resolveTimeout) => {
      const timer = setTimeout(() => resolveTimeout("timeout"), 5_000);
      timer.unref?.();
    });
    if (await Promise.race([exited.then(() => "exit" as const), timeout]) === "timeout" && plugin.child === child) {
      child.kill("SIGKILL");
      await exited.catch(() => undefined);
    }
  }

  private consumeOutput(plugin: ManagedPlugin, stream: "stdout" | "stderr", chunk: string): void {
    const key = stream === "stdout" ? "stdoutTail" : "stderrTail";
    plugin[key] += chunk;
    const lines = plugin[key].split(/\r?\n/);
    plugin[key] = lines.pop() ?? "";
    for (const line of lines) this.consumeLine(plugin, stream, line);
  }

  private flushTail(plugin: ManagedPlugin, stream: "stdout" | "stderr"): void {
    const key = stream === "stdout" ? "stdoutTail" : "stderrTail";
    const line = plugin[key].trim();
    plugin[key] = "";
    if (line) this.consumeLine(plugin, stream, line);
  }

  private consumeLine(plugin: ManagedPlugin, stream: "stdout" | "stderr", line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (stream === "stdout" && trimmed.startsWith("{")) {
      try {
        const message = JSON.parse(trimmed) as Record<string, unknown>;
        if (message.type === "sol.plugin.ready") {
          plugin.state = "running";
          plugin.health = healthValue(message.health) ?? "healthy";
          plugin.healthDetails = detailsValue(message.details);
          this.appendLog(plugin, "sol", "info", "Plugin reported ready");
          return;
        }
        if (message.type === "sol.plugin.health") {
          plugin.health = healthValue(message.status) ?? plugin.health;
          plugin.healthDetails = detailsValue(message.details);
          return;
        }
        if (message.type === "sol.plugin.log" && typeof message.message === "string") {
          const level = message.level === "debug" || message.level === "warn" || message.level === "error" ? message.level : "info";
          this.appendLog(plugin, "stdout", level, message.message);
          return;
        }
      } catch {
        // Normal stdout is intentionally supported alongside protocol messages.
      }
    }
    this.appendLog(plugin, stream, stream === "stderr" ? "error" : "info", trimmed);
  }

  private appendLog(
    plugin: ManagedPlugin,
    stream: SolPluginLogEntry["stream"],
    level: SolPluginLogEntry["level"],
    message: string,
  ): void {
    plugin.logs.push({ at: new Date().toISOString(), stream, level, message: message.slice(0, 8_000) });
    if (plugin.logs.length > this.logLimit) plugin.logs.splice(0, plugin.logs.length - this.logLimit);
  }
}
