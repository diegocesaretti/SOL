import type { SolPluginRuntimePrincipal, SolPluginScope } from "./types.js";
import { pluginManager } from "./runtime.js";
import {
  type SolPluginToolRegistration,
  type SolPluginToolView,
  validatePluginToolInput,
  validatePluginToolRegistration,
} from "./tool-registry.js";

interface RuntimeToolProvider {
  principal: SolPluginRuntimePrincipal;
  token: string;
  registration: SolPluginToolRegistration;
  registeredAt: string;
}

function sameScope(a: SolPluginScope, b: SolPluginScope): boolean {
  return a.householdId === b.householdId && a.memberId === b.memberId;
}

class PluginToolRuntime {
  private readonly providers = new Map<string, RuntimeToolProvider>();

  async register(
    principal: SolPluginRuntimePrincipal,
    token: string,
    value: unknown,
  ): Promise<SolPluginToolView[]> {
    const registration = validatePluginToolRegistration(value);
    const snapshot = await pluginManager.get(principal.pluginId);
    if (snapshot.state !== "running" && snapshot.state !== "starting") throw new Error("plugin_runtime_not_running");
    if (!snapshot.approvedPermissions.includes("tool.register")) throw new Error("plugin_permission_required:tool.register");
    if (!snapshot.approvedPermissions.includes("tool.execute")) throw new Error("plugin_permission_required:tool.execute");

    const activeProviders = await this.activeProviders();
    for (const tool of registration.tools) {
      const conflict = activeProviders.find(([pluginId, provider]) =>
        pluginId !== principal.pluginId &&
        sameScope(provider.principal, principal) &&
        provider.registration.tools.some((candidate) => candidate.name === tool.name));
      if (conflict) throw new Error(`plugin_tool_name_conflict:${tool.name}:${conflict[0]}`);
    }

    this.providers.set(principal.pluginId, {
      principal: { ...principal, permissions: [...principal.permissions] },
      token,
      registration,
      registeredAt: new Date().toISOString(),
    });
    return registration.tools.map((tool) => ({ ...tool, pluginId: principal.pluginId }));
  }

  async list(scope: SolPluginScope, allowExternalActions: boolean): Promise<SolPluginToolView[]> {
    const providers = await this.activeProviders();
    return providers
      .filter(([, provider]) => sameScope(provider.principal, scope))
      .flatMap(([pluginId, provider]) => provider.registration.tools
        .filter((tool) => allowExternalActions || !tool.requiresSubmit)
        .map((tool) => ({ ...tool, pluginId })))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async execute(
    scope: SolPluginScope,
    allowExternalActions: boolean,
    toolName: string,
    rawInput: unknown,
  ): Promise<unknown> {
    const providers = await this.activeProviders();
    const entry = providers.find(([, provider]) =>
      sameScope(provider.principal, scope) && provider.registration.tools.some((tool) => tool.name === toolName));
    if (!entry) throw new Error("plugin_tool_not_found");
    const [pluginId, provider] = entry;
    const tool = provider.registration.tools.find((candidate) => candidate.name === toolName)!;
    if (tool.requiresSubmit && !allowExternalActions) throw new Error("mcp_external_action_scope_required");
    const input = validatePluginToolInput(tool, rawInput);
    const snapshot = await pluginManager.get(pluginId);
    if (snapshot.state !== "running") throw new Error("plugin_tool_provider_not_running");
    if (!snapshot.approvedPermissions.includes("tool.execute")) throw new Error("plugin_permission_required:tool.execute");

    const response = await fetch(`${provider.registration.baseUrl}/api/sol-tools/${encodeURIComponent(toolName)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${provider.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(130_000),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const reason = typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
      throw new Error(`plugin_tool_failed:${pluginId}:${toolName}:${reason}`);
    }
    return payload;
  }

  private async activeProviders(): Promise<Array<[string, RuntimeToolProvider]>> {
    const result: Array<[string, RuntimeToolProvider]> = [];
    for (const [pluginId, provider] of this.providers) {
      const [snapshot, runtimePrincipal] = await Promise.all([
        pluginManager.get(pluginId).catch(() => undefined),
        pluginManager.authenticateRuntimeToken(provider.token).catch(() => null),
      ]);
      const validToken = runtimePrincipal &&
        runtimePrincipal.pluginId === pluginId &&
        sameScope(runtimePrincipal, provider.principal);
      if (!snapshot || !snapshot.enabled || !validToken || (snapshot.state !== "running" && snapshot.state !== "starting")) {
        this.providers.delete(pluginId);
        continue;
      }
      result.push([pluginId, provider]);
    }
    return result;
  }
}

export const pluginToolRuntime = new PluginToolRuntime();
