import type { SolPluginRuntimePrincipal } from "./types.js";
import { memberPrincipal } from "./runtime-core-read.js";

// Only Nexo, under the same ACTIVE SOL owner's runtime identity, can request
// these narrowly-scoped *local mission state* changes. This is NOT a generic
// MCP actions channel and never grants Nexo control of devices or outbound send.
const SUBMIT_TOOL_NAMES = new Set([
  "sol_agent_goal_create",
  "sol_agent_goal_pause",
  "sol_agent_goal_wake",
  "sol_agent_feedback",
]);

export async function authorizeNexoAgentSubmit(
  principal: SolPluginRuntimePrincipal,
  input: { name?: unknown; arguments?: unknown },
  resolveMember = memberPrincipal,
): Promise<void> {
  if (principal.pluginId !== "nexo-whatsapp") throw new Error("agent_submit_plugin_forbidden");
  if (!principal.permissions.includes("mcp.invoke.submit")) throw new Error("agent_submit_permission_required");
  if (typeof input.name !== "string" || !SUBMIT_TOOL_NAMES.has(input.name)) {
    throw new Error("agent_submit_tool_forbidden");
  }
  const args = input.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args), "utf8") > 2400)
    throw new Error("agent_submit_arguments_invalid");
  const actor = await resolveMember(principal);
  if (actor.householdId !== principal.householdId || actor.memberId !== principal.memberId || actor.role !== "owner")
    throw new Error("agent_submit_owner_required");
}
