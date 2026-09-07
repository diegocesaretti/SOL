import { readFile, writeFile, rm } from "node:fs/promises";

async function read(path) { return readFile(path, "utf8"); }
async function write(path, text) { await writeFile(path, text, "utf8"); }
function replace(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`Missing anchor: ${label}`);
  return text.replace(from, to);
}
function regex(text, re, to, label) {
  if (!re.test(text)) throw new Error(`Missing pattern: ${label}`);
  return text.replace(re, to);
}

for (const path of [
  "apps/server/src/modules/executive",
  "apps/server/src/ui/executive.ts",
  "apps/server/src/mcp/stdio.ts",
  "apps/server/src/types/qrcode.d.ts",
  "apps/server/src/ui/pages-script.test.ts",
  "apps/server/src/ui/whatsapp.test.ts",
]) await rm(path, { recursive: true, force: true });

let index = await read("apps/server/src/index.ts");
index = regex(index, /import \{ handleExecutiveApi \} from "\.\/modules\/executive\/routes\.js";\nimport \{ registerExecutiveProposalProcessor \} from "\.\/modules\/executive\/proposals\.js";\nimport \{ ExecutiveScheduler \} from "\.\/modules\/executive\/scheduler\.js";\n/, "", "executive imports");
index = replace(index, 'import { renderExecutivePage } from "./ui/executive.js";\n', "", "executive ui import");
index = replace(index, "const unregisterExecutiveProcessor = registerExecutiveProposalProcessor(eventBus);\n", "", "executive processor");
index = replace(index, "const executiveScheduler = new ExecutiveScheduler(config.executivePollMs);\n", "", "executive scheduler");
index = regex(index, /\n  if \(request\.method === "GET" && path === "\/executive"\) \{[\s\S]*?\n  \}\n/, "\n", "executive page");
index = regex(index, /\n  if \(path\.startsWith\("\/v1\/executive\/"\)\) \{[\s\S]*?\n  \}\n/, "\n", "executive api");
index = replace(index, "  if (config.nexoInternalAutomationEnabled) executiveScheduler.start();\n", "", "executive startup");
index = replace(index, "  executiveScheduler.stop();\n", "", "executive shutdown");
index = replace(index, "  unregisterExecutiveProcessor();\n", "", "executive unregister");
await write("apps/server/src/index.ts", index);

let cfg = await read("apps/server/src/config.ts");
cfg = regex(cfg, /\n  nexoInternalAutomationEnabled: booleanEnv\("NEXO_INTERNAL_AUTOMATION", false\),\n/, "\n", "internal automation config");
cfg = regex(cfg, /\n  executivePollMs: integerEnv\("SOL_EXECUTIVE_POLL_MS", 5 \* 60 \* 1000\),/, "", "executive poll config");
await write("apps/server/src/config.ts", cfg);

let mcpRoutes = await read("apps/server/src/modules/mcp/routes.ts");
mcpRoutes = regex(mcpRoutes, /\n      runtime: \{\n        internalAssistantBrain: config\.nexoInternalAutomationEnabled,\n        legacyBackgroundConnectors: config\.nexoLegacyConnectorsEnabled,\n      \},/, '\n      runtime: { externalSources: "plugins-only" },', "mcp runtime flags");
await write("apps/server/src/modules/mcp/routes.ts", mcpRoutes);

let mcpData = await read("apps/server/src/modules/mcp/data.ts");
mcpData = replace(mcpData, 'import { buildMercadoLibreReasoningContext } from "../connectors/mercadolibre/context.js";\n', "", "mercadolibre mcp import");
const homeStart = mcpData.indexOf("export async function getMcpHomeState(");
if (homeStart >= 0) mcpData = mcpData.slice(0, homeStart).trimEnd() + "\n";
await write("apps/server/src/modules/mcp/data.ts", mcpData);

let nexo = await read("apps/server/src/mcp/nexo-stdio.ts");
nexo = replace(nexo, 'import { getLastMorningBrief, runMorningBrief } from "../modules/executive/morning-brief.js";\nimport { getProactivitySettings, updateProactivitySettings } from "../modules/executive/proactivity.js";\n', "", "morning brief imports");
nexo = regex(nexo, /\n    server\.registerTool\("get_morning_brief_status",[\s\S]*?async \(\) => text\(await getLastMorningBrief\(principal\.memberId\)\)\);\n\n    server\.registerTool\("get_morning_brief_settings",[\s\S]*?\);\n/, "\n", "morning brief read tools");
nexo = regex(nexo, /\n      server\.registerTool\("run_morning_brief",[\s\S]*?updateProactivitySettings\(principal\.memberId, patch\)\)\);\n/, "\n", "morning brief write tools");
nexo = regex(nexo, /        const activeSources = sources\.filter\([\s\S]*?const dormantLegacySources = sources\.filter\([\s\S]*?\);\n/, "", "legacy source split");
nexo = replace(nexo, "          sources: activeSources,\n          dormantLegacySources,\n", "          sources,\n", "legacy source status output");
nexo = replace(nexo, '          role: "WhatsApp + shared SOL memory/context for Codex",', '          role: "SOL memory/context for Codex; external providers are installed as plugins",', "nexo role text");
await write("apps/server/src/mcp/nexo-stdio.ts", nexo);

const packagePath = "apps/server/package.json";
const pkg = JSON.parse(await read(packagePath));
delete pkg.scripts["mcp:legacy"];
for (const dep of ["baileys", "pino", "qrcode"]) delete pkg.dependencies[dep];
await write(packagePath, JSON.stringify(pkg, null, 2) + "\n");

let win = await read(".github/workflows/windows-package.yml");
win = replace(win, `            & $node --input-type=module -e "await import('pg'); await import('pino'); await import('zod'); await import('qrcode'); await import('baileys'); console.log('portable production dependencies resolve')"`, `            & $node --input-type=module -e "await import('pg'); await import('zod'); await import('@modelcontextprotocol/server'); console.log('portable production dependencies resolve')"`, "windows dependency check");
win = replace(win, `            'dist/windows/SOL/apps/server/node_modules/pg/package.json',\n            'dist/windows/SOL/apps/server/node_modules/pino/package.json',`, `            'dist/windows/SOL/apps/server/node_modules/pg/package.json',\n            'dist/windows/SOL/apps/server/node_modules/zod/package.json',`, "windows required deps");
await write(".github/workflows/windows-package.yml", win);

console.log("Final plugin-only core cleanup applied");
