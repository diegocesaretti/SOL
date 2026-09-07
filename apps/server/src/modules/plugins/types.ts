import { isAbsolute } from "node:path";

export type SolPluginRuntime = "node" | "executable";
export type SolPluginRestartPolicy = "never" | "on-failure";
export type SolPluginProcessState = "stopped" | "starting" | "running" | "error";
export type SolPluginHealth = "unknown" | "healthy" | "degraded" | "unhealthy";

export interface SolPluginManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description?: string;
  runtime: SolPluginRuntime;
  entry: string;
  args: string[];
  autoStart: boolean;
  restartPolicy: SolPluginRestartPolicy;
  capabilities: string[];
  permissions: string[];
}

export interface SolPluginLogEntry {
  at: string;
  stream: "sol" | "stdout" | "stderr";
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

export interface SolPluginSnapshot {
  manifest: SolPluginManifest;
  enabled: boolean;
  state: SolPluginProcessState;
  health: SolPluginHealth;
  healthDetails?: Record<string, unknown>;
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
  lastExitCode?: number | null;
  lastError?: string;
  lastLogAt?: string;
}

const ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const TOKEN_RE = /^[a-z0-9](?:[a-z0-9._:-]{0,118}[a-z0-9])?$/;

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const result = value.trim();
  if (!result || result.length > max) throw new Error(`${name} must be between 1 and ${max} characters`);
  return result;
}

export function safePluginRelativePath(value: unknown, name = "entry"): string {
  const raw = text(value, name, 260).replace(/\\/g, "/");
  if (raw.includes("\0") || raw.startsWith("/") || isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`${name} must be a relative path inside the plugin package`);
  }
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${name} cannot contain empty, . or .. path segments`);
  }
  return parts.join("/");
}

function stringArray(value: unknown, name: string, maxItems: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${name} must be an array with at most ${maxItems} items`);
  const result = value.map((item) => text(item, name, 120).toLowerCase());
  for (const item of result) {
    if (!TOKEN_RE.test(item)) throw new Error(`${name} contains an invalid token: ${item}`);
  }
  return [...new Set(result)];
}

export function validatePluginManifest(value: unknown): SolPluginManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("sol-plugin.json must contain an object");
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1) throw new Error("Unsupported plugin schemaVersion; expected 1");

  const id = text(input.id, "id", 64).toLowerCase();
  if (!ID_RE.test(id)) throw new Error("id must use lowercase letters, numbers, dot, underscore or hyphen");
  const name = text(input.name, "name", 120);
  const version = text(input.version, "version", 80);
  if (!VERSION_RE.test(version)) throw new Error("version must be a semantic version such as 1.0.0");
  const runtime = input.runtime === "node" || input.runtime === "executable" ? input.runtime : undefined;
  if (!runtime) throw new Error("runtime must be node or executable");
  const entry = safePluginRelativePath(input.entry);

  const args = input.args === undefined
    ? []
    : Array.isArray(input.args) && input.args.length <= 30
      ? input.args.map((arg) => text(arg, "args", 500))
      : (() => { throw new Error("args must be an array with at most 30 strings"); })();

  const autoStart = input.autoStart === undefined ? true : input.autoStart;
  if (typeof autoStart !== "boolean") throw new Error("autoStart must be a boolean");
  const restartPolicy = input.restartPolicy === undefined ? "on-failure" : input.restartPolicy;
  if (restartPolicy !== "never" && restartPolicy !== "on-failure") {
    throw new Error("restartPolicy must be never or on-failure");
  }

  const description = input.description === undefined ? undefined : text(input.description, "description", 500);
  return {
    schemaVersion: 1,
    id,
    name,
    version,
    description,
    runtime,
    entry,
    args,
    autoStart,
    restartPolicy,
    capabilities: stringArray(input.capabilities, "capabilities", 100),
    permissions: stringArray(input.permissions, "permissions", 100),
  };
}
