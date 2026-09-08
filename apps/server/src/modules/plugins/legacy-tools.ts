import * as z from "zod/v4";
import { validatePluginToolRegistration, type SolPluginToolRegistration } from "./tool-registry.js";

// Older official packages register a JSON Schema and one callback URL instead
// of a base URL and the simplified argument list. Keep both on the host registry.
export function legacyInputSchema(schema: Record<string, unknown>): z.ZodObject {
  const parsed = z.fromJSONSchema(schema);
  if (!(parsed instanceof z.ZodObject)) throw new Error("plugin_mcp_input_schema_must_be_object");
  return parsed;
}

export function validateLegacyRegistration(value: unknown): SolPluginToolRegistration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_mcp_registration");
  const input = value as Record<string, unknown>;
  if (typeof input.callbackUrl !== "string") throw new Error("callback_url_required");
  const url = new URL(input.callbackUrl);
  // Reuse the loopback/credentials validation without changing the callback path.
  const registration = validatePluginToolRegistration({ transport: "http", baseUrl: url.toString(), tools: [] });
  if (!Array.isArray(input.tools) || input.tools.length > 40) throw new Error("invalid_mcp_tools");
  const schemas: Record<string, unknown>[] = [];
  const tools = input.tools.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_mcp_tool");
    const tool = raw as Record<string, unknown>;
    // Preserve the provider's public tool names (e.g. codex_audio_status).
    // The unified registry checks reserved names and cross-provider conflicts.
    if (tool.requiresSubmit !== undefined && typeof tool.requiresSubmit !== "boolean") throw new Error("invalid_mcp_requires_submit");
    const scope = tool.requiredScope ?? "read";
    if (!["read", "submit", "actions"].includes(String(scope))) throw new Error("invalid_mcp_tool_scope");
    const schema = tool.inputSchema ?? { type: "object", properties: {} };
    if (!schema || typeof schema !== "object" || Array.isArray(schema) || Buffer.byteLength(JSON.stringify(schema)) > 48 * 1024) throw new Error("invalid_mcp_input_schema");
    legacyInputSchema(schema as Record<string, unknown>);
    schemas.push(schema as Record<string, unknown>);
    return { name: tool.name, description: tool.description, requiresSubmit: scope !== "read" || tool.requiresSubmit === true, input: [] };
  });
  const validated = validatePluginToolRegistration({ ...registration, tools });
  return { ...validated, callbackUrl: url.toString(), tools: validated.tools.map((tool, i) => ({ ...tool, inputSchema: schemas[i]! })) };
}
