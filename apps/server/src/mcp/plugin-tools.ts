import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { AuthPrincipal } from "../modules/auth/session.js";
import {
  invokePluginMcpTool,
  listPluginMcpTools,
  type PluginMcpTool,
} from "../modules/plugins/mcp-registry.js";

function zodValue(definition: unknown): any {
  const input = definition && typeof definition === "object" && !Array.isArray(definition)
    ? definition as Record<string, unknown>
    : {};
  let value: any;
  if (Object.prototype.hasOwnProperty.call(input, "const")) {
    value = z.literal(input.const as any);
  } else if (Array.isArray(input.enum) && input.enum.length > 0 && input.enum.every((item) => typeof item === "string")) {
    value = z.enum(input.enum as [string, ...string[]]);
  } else if (input.type === "string") {
    value = z.string();
    if (typeof input.minLength === "number") value = value.min(Math.max(0, Math.trunc(input.minLength)));
    if (typeof input.maxLength === "number") value = value.max(Math.max(0, Math.trunc(input.maxLength)));
  } else if (input.type === "integer") {
    value = z.number().int();
  } else if (input.type === "number") {
    value = z.number();
  } else if (input.type === "boolean") {
    value = z.boolean();
  } else if (input.type === "array") {
    value = z.array(zodValue(input.items));
  } else if (input.type === "object") {
    value = z.record(z.string(), z.unknown());
  } else {
    value = z.unknown();
  }
  if (typeof input.description === "string" && input.description.trim()) value = value.describe(input.description.trim());
  return value;
}

function zodInputSchema(schema: Record<string, unknown>): any {
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, unknown>
    : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []);
  const shape: Record<string, any> = {};
  for (const [name, definition] of Object.entries(properties)) {
    const value = zodValue(definition);
    shape[name] = required.has(name) ? value : value.optional();
  }
  return schema.additionalProperties === false ? z.object(shape).strict() : z.object(shape).passthrough();
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export async function loadPluginMcpTools(principal: AuthPrincipal, scopes: string[]): Promise<PluginMcpTool[]> {
  return await listPluginMcpTools(principal, scopes);
}

export function registerPluginMcpToolsOnServer(
  server: McpServer,
  principal: AuthPrincipal,
  tools: PluginMcpTool[],
): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: `${tool.description}\n\nProvided by SOL plugin: ${tool.pluginId}.`,
        inputSchema: zodInputSchema(tool.inputSchema),
      },
      async (args: Record<string, unknown>) => text(await invokePluginMcpTool(principal, tool, args)),
    );
  }
}
