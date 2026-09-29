import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { bridgeConnection, getBridgeCatalog, invokeBridgeTool, type RemoteToolDefinition, type SolScope } from "./state.js";

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

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
    if (typeof input.pattern === "string") {
      try { value = value.regex(new RegExp(input.pattern)); } catch { /* schema already validated by SOL */ }
    }
  } else if (input.type === "integer") {
    value = z.number().int();
    if (typeof input.minimum === "number") value = value.min(input.minimum);
    if (typeof input.maximum === "number") value = value.max(input.maximum);
  } else if (input.type === "number") {
    value = z.number();
    if (typeof input.minimum === "number") value = value.min(input.minimum);
    if (typeof input.maximum === "number") value = value.max(input.maximum);
  } else if (input.type === "boolean") {
    value = z.boolean();
  } else if (input.type === "array") {
    value = z.array(zodValue(input.items));
    if (typeof input.minItems === "number") value = value.min(Math.max(0, Math.trunc(input.minItems)));
    if (typeof input.maxItems === "number") value = value.max(Math.max(0, Math.trunc(input.maxItems)));
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
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  const shape: Record<string, any> = {};
  for (const [name, definition] of Object.entries(properties)) {
    const value = zodValue(definition);
    shape[name] = required.has(name) ? value : value.optional();
  }
  return schema.additionalProperties === false ? z.object(shape).strict() : z.object(shape).passthrough();
}

function oauthScope(scope: SolScope): string {
  if (scope === "actions") return "sol.actions";
  if (scope === "submit") return "sol.submit";
  return "sol.read";
}

function allowedByOauth(tool: RemoteToolDefinition, oauthScopes: string[]): boolean {
  return oauthScopes.includes(oauthScope(tool.requiredScope));
}

function normalizeResult(value: unknown): any {
  if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as { content?: unknown }).content)) {
    return value as any;
  }
  return text(value);
}

function toolRegistration(tool: RemoteToolDefinition): any {
  const scope = oauthScope(tool.requiredScope);
  return {
    title: tool.title,
    description: tool.description,
    inputSchema: zodInputSchema(tool.inputSchema),
    annotations: tool.annotations ?? {
      readOnlyHint: tool.requiredScope === "read",
      destructiveHint: tool.requiredScope !== "read",
      openWorldHint: false,
    },
    securitySchemes: [{ type: "oauth2", scopes: [scope] }],
    _meta: {
      "securitySchemes": [{ type: "oauth2", scopes: [scope] }],
      "sol/requiredScope": tool.requiredScope,
    },
  };
}

export const mcpHandler = createMcpHandler(({ authInfo }) => {
  const instanceId = authInfo?.clientId ?? "";
  const oauthScopes = Array.isArray(authInfo?.scopes) ? authInfo.scopes : [];
  const server = new McpServer(
    { name: "SOL", version: "1.0.0" },
    {
      instructions:
        "SOL is the user's private home/context backend. Query SOL before asserting live Home Assistant state. Never invent device state. Use read tools first to resolve the correct entity. Only invoke action tools when the user's current request clearly authorizes the action, and preserve the confirmation fields required by each SOL tool.",
    },
  );

  server.registerTool(
    "sol_profile",
    {
      title: "SOL account",
      description: "Return the connected SOL instance identity and current bridge health. Use this to confirm which SOL account/household is connected.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      securitySchemes: [{ type: "oauth2", scopes: ["sol.read"] }],
      _meta: {
        "openai/profile": true,
        "securitySchemes": [{ type: "oauth2", scopes: ["sol.read"] }],
      },
    } as any,
    async () => {
      const catalog = getBridgeCatalog(instanceId);
      return text({
        product: "SOL",
        instanceId,
        connected: bridgeConnection(instanceId),
        member: catalog?.profile ?? null,
      });
    },
  );

  const catalog = getBridgeCatalog(instanceId);
  for (const tool of catalog?.tools ?? []) {
    if (tool.name === "sol_profile" || !allowedByOauth(tool, oauthScopes)) continue;
    server.registerTool(
      tool.name,
      toolRegistration(tool),
      async (args: Record<string, unknown>) => normalizeResult(await invokeBridgeTool(instanceId, tool.name, args)),
    );
  }
  return server;
}, {
  responseMode: "json",
  onerror: (error) => console.error("SOL plugin MCP request failed", error),
});

export async function closeMcpHandler(): Promise<void> {
  await mcpHandler.close();
}
