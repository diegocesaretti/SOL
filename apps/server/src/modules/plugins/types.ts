import { isAbsolute } from "node:path";

export type SolPluginRuntime = "node" | "executable";
export type SolPluginRestartPolicy = "never" | "on-failure";
export type SolPluginProcessState = "stopped" | "starting" | "running" | "error";
export type SolPluginHealth = "unknown" | "healthy" | "degraded" | "unhealthy";
export type SolPluginSettingType = "text" | "boolean" | "number" | "select" | "path" | "secret";
export type SolPluginSettingValue = string | number | boolean;
export type SolPluginSchemaVersion = 1 | 2;

export const SOL_PLUGIN_HOST_CAPABILITIES = [
  "plugin-api.v1",
  "input.register",
  "input.write",
  "input.status",
  "identity.v1",
  "identity.read",
  "mcp.register",
  "mcp.invoke.read",
  "filesystem.plugin-data",
] as const;

export interface SolPluginScope {
  householdId: string;
  memberId: string;
}

export interface SolPluginRuntimePrincipal extends SolPluginScope {
  pluginId: string;
  permissions: string[];
}

export interface SolPluginSettingOption {
  value: string;
  label: string;
}

export interface SolPluginSettingDefinition {
  key: string;
  label: string;
  type: SolPluginSettingType;
  description?: string;
  env?: string;
  required: boolean;
  default?: SolPluginSettingValue;
  min?: number;
  max?: number;
  options?: SolPluginSettingOption[];
}

export interface SolPluginGithubReleaseDistribution {
  type: "github-release";
  asset: string;
  tag?: string;
}

export type SolPluginDistribution = SolPluginGithubReleaseDistribution;

export interface SolPluginManifest {
  schemaVersion: SolPluginSchemaVersion;
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
  requires: string[];
  permissions: string[];
  settings: SolPluginSettingDefinition[];
  distribution?: SolPluginDistribution;
}

export interface SolPluginSource {
  type: "file" | "github";
  repository?: string;
  ref?: string;
  releaseTag?: string;
  installedAt: string;
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
  approvedPermissions: string[];
  settings: Record<string, SolPluginSettingValue>;
  source?: SolPluginSource;
  scope?: SolPluginScope;
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
const SETTING_KEY_RE = /^[a-z][a-z0-9_]{0,62}$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const HOST_CAPABILITIES = new Set<string>(SOL_PLUGIN_HOST_CAPABILITIES);

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

function settingDefault(value: unknown, type: SolPluginSettingType, name: string): SolPluginSettingValue | undefined {
  if (value === undefined) return undefined;
  if (type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${name}.default must be boolean`);
    return value;
  }
  if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name}.default must be a finite number`);
    return value;
  }
  if (typeof value !== "string") throw new Error(`${name}.default must be a string`);
  return value;
}

function validateSettings(value: unknown): SolPluginSettingDefinition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 80) throw new Error("settings must be an array with at most 80 items");
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`settings[${index}] must be an object`);
    const input = item as Record<string, unknown>;
    const key = text(input.key, `settings[${index}].key`, 64).toLowerCase();
    if (!SETTING_KEY_RE.test(key)) throw new Error(`settings[${index}].key is invalid`);
    if (seen.has(key)) throw new Error(`duplicate setting key: ${key}`);
    seen.add(key);
    const label = text(input.label, `settings[${index}].label`, 120);
    const type = input.type;
    if (type !== "text" && type !== "boolean" && type !== "number" && type !== "select" && type !== "path" && type !== "secret") {
      throw new Error(`settings[${index}].type is invalid`);
    }
    const env = input.env === undefined ? undefined : text(input.env, `settings[${index}].env`, 128).toUpperCase();
    if (env && !ENV_RE.test(env)) throw new Error(`settings[${index}].env is invalid`);
    const required = input.required === undefined ? false : input.required;
    if (typeof required !== "boolean") throw new Error(`settings[${index}].required must be boolean`);
    const description = input.description === undefined ? undefined : text(input.description, `settings[${index}].description`, 500);
    const min = input.min === undefined ? undefined : Number(input.min);
    const max = input.max === undefined ? undefined : Number(input.max);
    if (min !== undefined && !Number.isFinite(min)) throw new Error(`settings[${index}].min must be a number`);
    if (max !== undefined && !Number.isFinite(max)) throw new Error(`settings[${index}].max must be a number`);
    if (min !== undefined && max !== undefined && min > max) throw new Error(`settings[${index}] min cannot exceed max`);
    let options: SolPluginSettingOption[] | undefined;
    if (input.options !== undefined) {
      if (!Array.isArray(input.options) || input.options.length > 100) throw new Error(`settings[${index}].options must be an array`);
      options = input.options.map((option, optionIndex) => {
        if (!option || typeof option !== "object" || Array.isArray(option)) throw new Error(`settings[${index}].options[${optionIndex}] must be an object`);
        const record = option as Record<string, unknown>;
        return {
          value: text(record.value, `settings[${index}].options[${optionIndex}].value`, 200),
          label: text(record.label, `settings[${index}].options[${optionIndex}].label`, 200),
        };
      });
    }
    if (type === "select" && (!options || !options.length)) throw new Error(`settings[${index}] select requires options`);
    const defaultValue = settingDefault(input.default, type, `settings[${index}]`);
    if (type === "select" && defaultValue !== undefined && !options?.some((option) => option.value === defaultValue)) {
      throw new Error(`settings[${index}].default must match an option`);
    }
    return { key, label, type, description, env, required, default: defaultValue, min, max, options };
  });
}

function validateDistribution(value: unknown): SolPluginDistribution | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("distribution must be an object");
  const input = value as Record<string, unknown>;
  if (input.type !== "github-release") throw new Error("distribution.type must be github-release");
  const asset = text(input.asset, "distribution.asset", 180);
  if (asset.includes("/") || asset.includes("\\")) throw new Error("distribution.asset must be a file name");
  const tag = input.tag === undefined ? undefined : text(input.tag, "distribution.tag", 180);
  return { type: "github-release", asset, tag };
}

export function missingRequiredSettingKeys(
  definitions: SolPluginSettingDefinition[],
  values: Record<string, SolPluginSettingValue>,
): string[] {
  return definitions
    .filter((definition) => definition.required && values[definition.key] === undefined && definition.default === undefined)
    .map((definition) => definition.key);
}

export function validateSettingValues(
  definitions: SolPluginSettingDefinition[],
  value: unknown,
  options: { allowMissingRequired?: boolean } = {},
): Record<string, SolPluginSettingValue> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("settings values must be an object");
  const input = value as Record<string, unknown>;
  const definitionsByKey = new Map(definitions.map((definition) => [definition.key, definition]));
  const result: Record<string, SolPluginSettingValue> = {};
  for (const [key, raw] of Object.entries(input)) {
    const definition = definitionsByKey.get(key);
    if (!definition) throw new Error(`unknown plugin setting: ${key}`);
    if (raw === undefined || raw === null || raw === "") {
      if (definition.required && !options.allowMissingRequired) throw new Error(`setting ${key} is required`);
      continue;
    }
    if (definition.type === "boolean") {
      if (typeof raw !== "boolean") throw new Error(`setting ${key} must be boolean`);
      result[key] = raw;
      continue;
    }
    if (definition.type === "number") {
      const numberValue = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(numberValue)) throw new Error(`setting ${key} must be numeric`);
      if (definition.min !== undefined && numberValue < definition.min) throw new Error(`setting ${key} must be >= ${definition.min}`);
      if (definition.max !== undefined && numberValue > definition.max) throw new Error(`setting ${key} must be <= ${definition.max}`);
      result[key] = numberValue;
      continue;
    }
    if (typeof raw !== "string") throw new Error(`setting ${key} must be text`);
    const stringValue = raw.trim();
    if (!stringValue && definition.required && !options.allowMissingRequired) throw new Error(`setting ${key} is required`);
    if (stringValue.length > 2_000) throw new Error(`setting ${key} is too long`);
    if (definition.type === "select" && !definition.options?.some((option) => option.value === stringValue)) {
      throw new Error(`setting ${key} must match one of its options`);
    }
    if (stringValue) result[key] = stringValue;
  }
  if (!options.allowMissingRequired) {
    const missing = missingRequiredSettingKeys(definitions, result);
    if (missing.length) throw new Error(`setting ${missing[0]} is required`);
  }
  return result;
}

export function validatePluginManifest(value: unknown): SolPluginManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("sol-plugin.json must contain an object");
  const input = value as Record<string, unknown>;
  const schemaVersion = input.schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== 2) throw new Error("Unsupported plugin schemaVersion; expected 1 or 2");
  if (schemaVersion === 1 && input.requires !== undefined) {
    throw new Error("requires is only supported by plugin schemaVersion 2");
  }

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

  const requires = schemaVersion === 2 ? stringArray(input.requires, "requires", 100) : [];
  const missingRequirements = requires.filter((requirement) => !HOST_CAPABILITIES.has(requirement));
  if (missingRequirements.length) {
    throw new Error(`plugin_host_capabilities_required:${missingRequirements.join(",")}`);
  }

  const description = input.description === undefined ? undefined : text(input.description, "description", 500);
  return {
    schemaVersion,
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
    requires,
    permissions: stringArray(input.permissions, "permissions", 100),
    settings: validateSettings(input.settings),
    distribution: validateDistribution(input.distribution),
  };
}
