import { readFile, writeFile } from "node:fs/promises";

async function patch(path, transforms) {
  let text = await readFile(path, "utf8");
  let changed = false;
  for (const [from, to] of transforms) {
    if (text.includes(to)) continue;
    if (!text.includes(from)) throw new Error(`Patch anchor not found in ${path}: ${from.slice(0, 100)}`);
    text = text.replace(from, to);
    changed = true;
  }
  if (changed) await writeFile(path, text, "utf8");
}

await patch("apps/server/src/modules/plugins/types.ts", [
  [
    'export type SolPluginSettingValue = string | number | boolean;\n',
    'export type SolPluginSettingValue = string | number | boolean;\n\nexport interface SolPluginScope {\n  householdId: string;\n  memberId: string;\n}\n\nexport interface SolPluginRuntimePrincipal extends SolPluginScope {\n  pluginId: string;\n  permissions: string[];\n}\n',
  ],
  [
    '  source?: SolPluginSource;\n  pid?: number;\n',
    '  source?: SolPluginSource;\n  scope?: SolPluginScope;\n  pid?: number;\n',
  ],
]);

await patch("apps/server/src/modules/ingestion/plugin-input-service.ts", [
  [
    'import { scoreIntelligenceCandidate } from "../knowledge/intelligence-gate.js";\n\nexport interface PluginRuntimePrincipal {\n  pluginId: string;\n  householdId: string;\n  memberId: string;\n  permissions: string[];\n}\n',
    'import { scoreIntelligenceCandidate } from "../knowledge/intelligence-gate.js";\nimport type { SolPluginRuntimePrincipal } from "../plugins/types.js";\n',
  ],
  ['principal: PluginRuntimePrincipal', 'principal: SolPluginRuntimePrincipal'],
]);

await patch("apps/server/src/modules/ingestion/plugin-input-routes.ts", [
  [
    '  type PluginRuntimePrincipal,\n} from "./plugin-input-service.js";\n',
    '} from "./plugin-input-service.js";\nimport type { SolPluginRuntimePrincipal } from "../plugins/types.js";\n',
  ],
  ['principal: PluginRuntimePrincipal', 'principal: SolPluginRuntimePrincipal'],
  ['Promise<PluginRuntimePrincipal | null>', 'Promise<SolPluginRuntimePrincipal | null>'],
]);

await patch("apps/server/src/modules/plugins/manager.ts", [
  ['import { randomUUID } from "node:crypto";', 'import { randomBytes, randomUUID } from "node:crypto";'],
  [
    '  type SolPluginSettingValue,\n  type SolPluginSnapshot,\n  type SolPluginSource,\n',
    '  type SolPluginRuntimePrincipal,\n  type SolPluginScope,\n  type SolPluginSettingValue,\n  type SolPluginSnapshot,\n  type SolPluginSource,\n',
  ],
  [
    '  source?: SolPluginSource;\n}\n\ninterface PersistedState',
    '  source?: SolPluginSource;\n  scope?: SolPluginScope;\n}\n\ninterface PersistedState',
  ],
  [
    '  expectedManifest?: Pick<SolPluginManifest, "id" | "name" | "version" | "permissions">;\n}',
    '  expectedManifest?: Pick<SolPluginManifest, "id" | "name" | "version" | "permissions">;\n  scope?: SolPluginScope;\n}',
  ],
  [
    '  source?: SolPluginSource;\n  state: SolPluginProcessState;',
    '  source?: SolPluginSource;\n  scope?: SolPluginScope;\n  runtimeToken?: string;\n  state: SolPluginProcessState;',
  ],
  [
    '  private readonly plugins = new Map<string, ManagedPlugin>();\n  private initialized = false;',
    '  private readonly plugins = new Map<string, ManagedPlugin>();\n  private readonly runtimeTokens = new Map<string, SolPluginRuntimePrincipal>();\n  private initialized = false;',
  ],
  [
    '          saved?.settings ?? {},\n          saved?.source,\n        ));',
    '          saved?.settings ?? {},\n          saved?.source,\n          saved?.scope,\n        ));',
  ],
  [
    '  async get(id: string): Promise<SolPluginSnapshot> {\n    await this.init();\n    return this.snapshot(this.requirePlugin(id));\n  }\n',
    '  async get(id: string): Promise<SolPluginSnapshot> {\n    await this.init();\n    return this.snapshot(this.requirePlugin(id));\n  }\n\n  async authenticateRuntimeToken(token: string): Promise<SolPluginRuntimePrincipal | null> {\n    await this.init();\n    const principal = this.runtimeTokens.get(token);\n    return principal ? { ...principal, permissions: [...principal.permissions] } : null;\n  }\n',
  ],
  [
    '      const record = this.createRecord(manifest, destination, manifest.autoStart, approvals, settings, source);',
    '      const record = this.createRecord(manifest, destination, manifest.autoStart, approvals, settings, source, options.scope);',
  ],
  [
    '    settings: Record<string, SolPluginSettingValue>,\n    source?: SolPluginSource,\n  ): ManagedPlugin {',
    '    settings: Record<string, SolPluginSettingValue>,\n    source?: SolPluginSource,\n    scope?: SolPluginScope,\n  ): ManagedPlugin {',
  ],
  [
    '      settings: { ...settings },\n      source,\n      state: "stopped",',
    '      settings: { ...settings },\n      source,\n      scope,\n      state: "stopped",',
  ],
  [
    '        settings: plugin.settings,\n        source: plugin.source,\n      };',
    '        settings: plugin.settings,\n        source: plugin.source,\n        scope: plugin.scope,\n      };',
  ],
  [
    '      source: plugin.source,\n      pid: plugin.pid,',
    '      source: plugin.source,\n      scope: plugin.scope,\n      pid: plugin.pid,',
  ],
  [
    '    const pluginEnv: NodeJS.ProcessEnv = {\n      ...process.env,\n      SOL_PLUGIN_ID: plugin.manifest.id,\n      SOL_PLUGIN_ROOT: plugin.directory,\n      SOL_CORE_URL: this.coreUrl,\n      SOL_PLUGIN_APPROVED_PERMISSIONS: JSON.stringify(plugin.approvedPermissions),\n    };',
    '    this.revokeRuntimeToken(plugin);\n    const pluginEnv: NodeJS.ProcessEnv = { ...process.env };\n    for (const key of Object.keys(pluginEnv)) {\n      const upper = key.toUpperCase();\n      if (upper === "DATABASE_URL" || upper === "NEXO_DATABASE_URL" || /(SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)$/.test(upper)) {\n        delete pluginEnv[key];\n      }\n    }\n    pluginEnv.SOL_PLUGIN_ID = plugin.manifest.id;\n    pluginEnv.SOL_PLUGIN_ROOT = plugin.directory;\n    pluginEnv.SOL_CORE_URL = this.coreUrl;\n    pluginEnv.SOL_PLUGIN_API_URL = this.coreUrl;\n    pluginEnv.SOL_PLUGIN_APPROVED_PERMISSIONS = JSON.stringify(plugin.approvedPermissions);\n    if (plugin.scope) {\n      const token = randomBytes(32).toString("base64url");\n      const principal: SolPluginRuntimePrincipal = {\n        pluginId: plugin.manifest.id,\n        householdId: plugin.scope.householdId,\n        memberId: plugin.scope.memberId,\n        permissions: [...plugin.approvedPermissions],\n      };\n      plugin.runtimeToken = token;\n      this.runtimeTokens.set(token, principal);\n      pluginEnv.SOL_PLUGIN_TOKEN = token;\n      pluginEnv.SOL_HOUSEHOLD_ID = plugin.scope.householdId;\n      pluginEnv.SOL_MEMBER_ID = plugin.scope.memberId;\n    }',
  ],
  [
    '      plugin.child = undefined;\n      plugin.pid = undefined;\n      plugin.state = "error";',
    '      plugin.child = undefined;\n      plugin.pid = undefined;\n      this.revokeRuntimeToken(plugin);\n      plugin.state = "error";',
  ],
  [
    '    plugin.child = undefined;\n    plugin.pid = undefined;\n    plugin.lastExitCode = code;',
    '    plugin.child = undefined;\n    plugin.pid = undefined;\n    this.revokeRuntimeToken(plugin);\n    plugin.lastExitCode = code;',
  ],
  [
    '    if (!child) {\n      plugin.state = "stopped";',
    '    if (!child) {\n      this.revokeRuntimeToken(plugin);\n      plugin.state = "stopped";',
  ],
  [
    '  private handleExit(plugin: ManagedPlugin, child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {',
    '  private revokeRuntimeToken(plugin: ManagedPlugin): void {\n    if (!plugin.runtimeToken) return;\n    this.runtimeTokens.delete(plugin.runtimeToken);\n    plugin.runtimeToken = undefined;\n  }\n\n  private handleExit(plugin: ManagedPlugin, child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {',
  ],
]);

await patch("apps/server/src/modules/plugins/routes.ts", [
  [
    '      sendJson(response, 201, { plugin: await pluginManager.installPackage(packageBytes) });',
    '      sendJson(response, 201, { plugin: await pluginManager.installPackage(packageBytes, { scope: { householdId: principal.householdId, memberId: principal.memberId } }) });',
  ],
  [
    '        source: {\n          type: "github",',
    '        scope: { householdId: principal.householdId, memberId: principal.memberId },\n        source: {\n          type: "github",',
  ],
]);

await patch("apps/server/src/index.ts", [
  [
    'import { handleInputsApi } from "./modules/inputs/routes.js";\n',
    'import { handleInputsApi } from "./modules/inputs/routes.js";\nimport { handlePluginInputApi } from "./modules/ingestion/plugin-input-routes.js";\n',
  ],
  [
    '  const path = pathname(request);\n\n  // OAuth callbacks are authenticated',
    '  const path = pathname(request);\n\n  // Plugin runtime calls use a short-lived bearer token issued by PluginManager,\n  // not a browser session cookie and never direct database credentials.\n  if (path.startsWith("/v1/plugin-api/")) {\n    if (await handlePluginInputApi(path, request, response)) return;\n  }\n\n  // OAuth callbacks are authenticated',
  ],
  [
    '  outboxDispatcher.start();\n  calendarScheduler.start();\n  gmailScheduler.start();\n  mercadoLibreScheduler.start();\n  executiveScheduler.start();\n  void whatsappManager.startLinkedAccounts().catch((error) => {\n    console.error("WhatsApp autostart failed", error);\n  });\n  void homeAssistantManager.startConfiguredAccounts().catch((error) => {\n    console.error("Home Assistant autostart failed", error);\n  });',
    '  outboxDispatcher.start();\n  if (config.nexoLegacyConnectorsEnabled) {\n    calendarScheduler.start();\n    gmailScheduler.start();\n    mercadoLibreScheduler.start();\n    void whatsappManager.startLinkedAccounts().catch((error) => {\n      console.error("WhatsApp legacy autostart failed", error);\n    });\n    void homeAssistantManager.startConfiguredAccounts().catch((error) => {\n      console.error("Home Assistant legacy autostart failed", error);\n    });\n  } else {\n    console.log("External native connectors are disabled; install providers as SOL plugins (set NEXO_LEGACY_CONNECTORS=true for fallback).");\n  }\n  if (config.nexoInternalAutomationEnabled) executiveScheduler.start();',
  ],
]);

console.log("Plugin Input API v1 integration applied");
