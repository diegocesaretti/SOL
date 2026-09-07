export type SolPluginToolArgumentType = "string" | "number" | "boolean" | "string_array";

export interface SolPluginToolArgumentDefinition {
  name: string;
  type: SolPluginToolArgumentType;
  description?: string;
  required: boolean;
  min?: number;
  max?: number;
  enum?: string[];
  literalTrue?: boolean;
}

export interface SolPluginToolDefinition {
  name: string;
  description: string;
  requiresSubmit: boolean;
  input: SolPluginToolArgumentDefinition[];
}

export interface SolPluginToolRegistration {
  transport: "http";
  baseUrl: string;
  tools: SolPluginToolDefinition[];
}

export interface SolPluginToolView extends SolPluginToolDefinition {
  pluginId: string;
}

const TOOL_NAME_RE = /^[a-z][a-z0-9_-]{1,79}$/;
const ARG_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

export const CORE_MCP_TOOL_NAMES = new Set([
  "sol_status",
  "get_timeline",
  "search_life",
  "list_people",
  "list_projects",
  "memory_search",
  "save_observation",
  "remember_fact",
  "correct_memory",
  "forget_memory",
  "save_schedule",
]);

function stringValue(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const result = value.trim();
  if (!result || result.length > max) throw new Error(`${name} must be between 1 and ${max} characters`);
  return result;
}

function validateLoopbackBaseUrl(value: unknown): string {
  const raw = stringValue(value, "baseUrl", 300);
  const url = new URL(raw);
  if (url.protocol !== "http:") throw new Error("plugin tool baseUrl must use http on loopback");
  const host = url.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && host !== "[::1]") {
    throw new Error("plugin tool baseUrl must use a loopback host");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("plugin tool baseUrl cannot contain credentials, query or fragment");
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function validateArgument(value: unknown, toolIndex: number, argumentIndex: number): SolPluginToolArgumentDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`tools[${toolIndex}].input[${argumentIndex}] must be an object`);
  }
  const input = value as Record<string, unknown>;
  const name = stringValue(input.name, `tools[${toolIndex}].input[${argumentIndex}].name`, 64);
  if (!ARG_NAME_RE.test(name)) throw new Error(`invalid tool argument name: ${name}`);
  const type = input.type;
  if (type !== "string" && type !== "number" && type !== "boolean" && type !== "string_array") {
    throw new Error(`invalid tool argument type for ${name}`);
  }
  const required = input.required === undefined ? false : input.required;
  if (typeof required !== "boolean") throw new Error(`tool argument ${name}.required must be boolean`);
  const description = input.description === undefined ? undefined : stringValue(input.description, `${name}.description`, 500);
  const min = input.min === undefined ? undefined : Number(input.min);
  const max = input.max === undefined ? undefined : Number(input.max);
  if (min !== undefined && !Number.isFinite(min)) throw new Error(`${name}.min must be numeric`);
  if (max !== undefined && !Number.isFinite(max)) throw new Error(`${name}.max must be numeric`);
  if (min !== undefined && max !== undefined && min > max) throw new Error(`${name}.min cannot exceed max`);
  let enumValues: string[] | undefined;
  if (input.enum !== undefined) {
    if (type !== "string" || !Array.isArray(input.enum) || input.enum.length < 1 || input.enum.length > 100) {
      throw new Error(`${name}.enum must be a non-empty string enum`);
    }
    enumValues = [...new Set(input.enum.map((item) => stringValue(item, `${name}.enum`, 120)))];
  }
  const literalTrue = input.literalTrue === true;
  if (literalTrue && type !== "boolean") throw new Error(`${name}.literalTrue is only valid for booleans`);
  return { name, type, description, required, min, max, enum: enumValues, literalTrue };
}

export function validatePluginToolRegistration(value: unknown): SolPluginToolRegistration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tool registration must be an object");
  const input = value as Record<string, unknown>;
  if (input.transport !== "http") throw new Error("tool registration transport must be http");
  const baseUrl = validateLoopbackBaseUrl(input.baseUrl);
  if (!Array.isArray(input.tools) || input.tools.length > 100) throw new Error("tools must be an array with at most 100 items");
  const seenTools = new Set<string>();
  const tools = input.tools.map((value, toolIndex) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`tools[${toolIndex}] must be an object`);
    const record = value as Record<string, unknown>;
    const name = stringValue(record.name, `tools[${toolIndex}].name`, 80).toLowerCase();
    if (!TOOL_NAME_RE.test(name)) throw new Error(`invalid tool name: ${name}`);
    if (CORE_MCP_TOOL_NAMES.has(name)) throw new Error(`reserved core tool name: ${name}`);
    if (seenTools.has(name)) throw new Error(`duplicate tool name: ${name}`);
    seenTools.add(name);
    const description = stringValue(record.description, `tools[${toolIndex}].description`, 1000);
    const requiresSubmit = record.requiresSubmit === undefined ? false : record.requiresSubmit;
    if (typeof requiresSubmit !== "boolean") throw new Error(`tools[${toolIndex}].requiresSubmit must be boolean`);
    const rawArguments = record.input === undefined ? [] : record.input;
    if (!Array.isArray(rawArguments) || rawArguments.length > 50) throw new Error(`tools[${toolIndex}].input must be an array`);
    const seenArguments = new Set<string>();
    const argumentsList = rawArguments.map((argument, argumentIndex) => {
      const parsed = validateArgument(argument, toolIndex, argumentIndex);
      if (seenArguments.has(parsed.name)) throw new Error(`duplicate argument ${parsed.name} in tool ${name}`);
      seenArguments.add(parsed.name);
      return parsed;
    });
    return { name, description, requiresSubmit, input: argumentsList };
  });
  return { transport: "http", baseUrl, tools };
}

export function validatePluginToolInput(
  tool: SolPluginToolDefinition,
  value: unknown,
): Record<string, unknown> {
  if (value === undefined || value === null) value = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("plugin_tool_input_must_be_object");
  }
  const input = value as Record<string, unknown>;
  const definitions = new Map(tool.input.map((argument) => [argument.name, argument]));
  for (const name of Object.keys(input)) {
    if (!definitions.has(name)) throw new Error(`plugin_tool_input_unknown:${name}`);
  }

  const result: Record<string, unknown> = {};
  for (const argument of tool.input) {
    const present = Object.prototype.hasOwnProperty.call(input, argument.name);
    if (!present) {
      if (argument.required) throw new Error(`plugin_tool_input_required:${argument.name}`);
      continue;
    }
    const current = input[argument.name];
    if (argument.type === "boolean") {
      if (typeof current !== "boolean") throw new Error(`plugin_tool_input_boolean:${argument.name}`);
      if (argument.literalTrue && current !== true) throw new Error(`plugin_tool_input_literal_true:${argument.name}`);
    } else if (argument.type === "number") {
      if (typeof current !== "number" || !Number.isFinite(current)) throw new Error(`plugin_tool_input_number:${argument.name}`);
      if (argument.min !== undefined && current < argument.min) throw new Error(`plugin_tool_input_min:${argument.name}`);
      if (argument.max !== undefined && current > argument.max) throw new Error(`plugin_tool_input_max:${argument.name}`);
    } else if (argument.type === "string_array") {
      if (!Array.isArray(current) || current.some((item) => typeof item !== "string")) {
        throw new Error(`plugin_tool_input_string_array:${argument.name}`);
      }
      if (argument.min !== undefined && current.length < argument.min) throw new Error(`plugin_tool_input_min:${argument.name}`);
      if (argument.max !== undefined && current.length > argument.max) throw new Error(`plugin_tool_input_max:${argument.name}`);
    } else {
      if (typeof current !== "string") throw new Error(`plugin_tool_input_string:${argument.name}`);
      if (argument.min !== undefined && current.length < argument.min) throw new Error(`plugin_tool_input_min:${argument.name}`);
      if (argument.max !== undefined && current.length > argument.max) throw new Error(`plugin_tool_input_max:${argument.name}`);
      if (argument.enum?.length && !argument.enum.includes(current)) throw new Error(`plugin_tool_input_enum:${argument.name}`);
    }
    result[argument.name] = current;
  }
  return result;
}
