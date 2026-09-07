import { readFile, writeFile, rm } from "node:fs/promises";

async function read(path) { return readFile(path, "utf8"); }
async function write(path, text) { await writeFile(path, text, "utf8"); }
function mustReplace(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`Missing anchor: ${label}`);
  return text.replace(from, to);
}
function mustRegex(text, re, to, label) {
  if (!re.test(text)) throw new Error(`Missing pattern: ${label}`);
  return text.replace(re, to);
}

const removedConnectorDirs = [
  "apps/server/src/modules/connectors/gmail",
  "apps/server/src/modules/connectors/google-calendar",
  "apps/server/src/modules/connectors/home-assistant",
  "apps/server/src/modules/connectors/mercadolibre",
  "apps/server/src/modules/connectors/sol-whatsapp",
  "apps/server/src/modules/connectors/whatsapp",
];
for (const dir of removedConnectorDirs) await rm(dir, { recursive: true, force: true });
for (const file of [
  "apps/server/src/ui/calendar.ts",
  "apps/server/src/ui/home-assistant.ts",
  "apps/server/src/ui/mercadolibre.ts",
  "apps/server/src/ui/sol-whatsapp.ts",
  "apps/server/src/ui/whatsapp.ts",
]) await rm(file, { force: true });

let index = await read("apps/server/src/index.ts");
index = mustRegex(index, /import \{\n  handleCalendarApi,\n  handleGoogleOAuthCallback,\n\} from "\.\/modules\/connectors\/google-calendar\/routes\.js";\nimport \{ CalendarSyncScheduler \} from "\.\/modules\/connectors\/google-calendar\/scheduler\.js";\n/, "", "calendar imports");
index = mustRegex(index, /import \{ handleGmailApi, handleGmailOAuthCallback \} from "\.\/modules\/connectors\/gmail\/routes\.js";\nimport \{ GmailSyncScheduler \} from "\.\/modules\/connectors\/gmail\/scheduler\.js";\n/, "", "gmail imports");
index = mustRegex(index, /import \{ homeAssistantManager \} from "\.\/modules\/connectors\/home-assistant\/manager\.js";\nimport \{ handleHomeAssistantApi \} from "\.\/modules\/connectors\/home-assistant\/routes\.js";\n/, "", "ha imports");
index = mustRegex(index, /import \{\n  handleMercadoLibreApi,\n  handleMercadoLibreOAuthCallback,\n\} from "\.\/modules\/connectors\/mercadolibre\/routes\.js";\nimport \{ MercadoLibreSyncScheduler \} from "\.\/modules\/connectors\/mercadolibre\/scheduler\.js";\n/, "", "ml imports");
index = mustRegex(index, /import \{ handleSolWhatsappApi \} from "\.\/modules\/connectors\/sol-whatsapp\/routes\.js";\nimport \{ registerSolWhatsappDelivery \} from "\.\/modules\/connectors\/sol-whatsapp\/service\.js";\nimport \{ handleWhatsappApi \} from "\.\/modules\/connectors\/whatsapp\/routes\.js";\nimport \{ whatsappManager \} from "\.\/modules\/connectors\/whatsapp\/manager\.js";\n/, "", "whatsapp imports");
index = mustRegex(index, /import \{\n  createSourceAccount,\n  listSourceAccounts,\n  SourceAccountValidationError,\n\} from "\.\/modules\/identity\/source-accounts\.js";/, 'import { listSourceAccounts } from "./modules/identity/source-accounts.js";', "source account imports");
for (const uiImport of [
  'import { renderCalendarPage } from "./ui/calendar.js";\n',
  'import { renderHomeAssistantPage } from "./ui/home-assistant.js";\n',
  'import { renderMercadoLibrePage } from "./ui/mercadolibre.js";\n',
  'import { renderSolWhatsappPage } from "./ui/sol-whatsapp.js";\n',
  'import { renderWhatsappPage } from "./ui/whatsapp.js";\n',
]) index = mustReplace(index, uiImport, "", `ui import ${uiImport}`);
index = mustReplace(index, "const unregisterSolWhatsappDelivery = registerSolWhatsappDelivery(eventBus, whatsappManager);\n", "", "sol whatsapp delivery");
index = mustReplace(index, "const calendarScheduler = new CalendarSyncScheduler(config.calendarSyncMs);\nconst gmailScheduler = new GmailSyncScheduler(config.gmailSyncMs);\nconst mercadoLibreScheduler = new MercadoLibreSyncScheduler(config.mercadoLibreSyncMs);\n", "", "connector schedulers");
index = mustRegex(index, /\n  \/\/ OAuth callbacks are authenticated[\s\S]*?if \(await handleMercadoLibreOAuthCallback\(request, response\)\) return;\n/, "\n", "oauth callbacks");
index = mustRegex(index, /\n  \/\/ Provider-specific pages remain available[\s\S]*?  if \(request\.method === "GET" && path === "\/executive"\) \{/, '\n  if (request.method === "GET" && path === "/executive") {', "provider pages");
for (const route of [
  ["sol-whatsapp", /\n  if \(path\.startsWith\("\/v1\/sol-whatsapp"\)\) \{[\s\S]*?\n  \}/],
  ["whatsapp", /\n  if \(path\.startsWith\("\/v1\/whatsapp\/"\)\) \{[\s\S]*?\n  \}/],
  ["gmail", /\n  if \(path\.startsWith\("\/v1\/gmail"\)\) \{[\s\S]*?\n  \}/],
  ["calendar", /\n  if \(path\.startsWith\("\/v1\/calendar\/"\)\) \{[\s\S]*?\n  \}/],
  ["home-assistant", /\n  if \(path\.startsWith\("\/v1\/home-assistant"\)\) \{[\s\S]*?\n  \}/],
  ["mercadolibre", /\n  if \(path\.startsWith\("\/v1\/mercadolibre\/"\)\) \{[\s\S]*?\n  \}/],
]) index = mustRegex(index, route[1], "", `native route ${route[0]}`);
index = mustReplace(index, '      sources: ["whatsapp", "gmail", "google_calendar", "home_assistant", "mercadolibre"],\n      interfaces: ["mcp_stdio", "web", "sol_whatsapp", "windows_tray"],\n      views: ["inputs", "outputs", "life_timeline", "people", "projects", "mcp_access"],\n      plannedSources: ["google_drive", "contacts", "voice"],', '      sourceMode: "plugins-only",\n      sources: [],\n      interfaces: ["mcp_stdio", "web", "plugin_runtime", "windows_tray"],\n      views: ["inputs", "outputs", "life_timeline", "people", "projects", "mcp_access"],', "system sources");
const sourceStart = index.indexOf('  if (path === "/v1/source-accounts") {');
const membersStart = index.indexOf('  const membersMatch = path.match(', sourceStart);
if (sourceStart < 0 || membersStart < 0) throw new Error("source account route block not found");
index = index.slice(0, sourceStart) + `  if (path === "/v1/source-accounts") {\n    const principal = await principalFor(request, response);\n    if (!principal) return;\n    if (request.method !== "GET") {\n      sendJson(response, 405, { error: "source_accounts_are_plugin_managed" });\n      return;\n    }\n    const canSeeAll = principal.role === "owner" || principal.role === "adult";\n    sendJson(response, 200, {\n      sourceAccounts: await listSourceAccounts(principal.householdId, principal.memberId, canSeeAll),\n    });\n    return;\n  }\n\n` + index.slice(membersStart);
index = mustRegex(index, /  if \(config\.nexoLegacyConnectorsEnabled\) \{[\s\S]*?  \} else \{\n    console\.log\("External native connectors are disabled; install providers as SOL plugins \(set NEXO_LEGACY_CONNECTORS=true for fallback\)\."\);\n  \}\n/, '  console.log("External sources are plugin-only; install providers from Services.");\n', "legacy startup");
index = mustReplace(index, "  calendarScheduler.stop();\n  gmailScheduler.stop();\n  mercadoLibreScheduler.stop();\n", "", "scheduler shutdown");
index = mustReplace(index, "  unregisterSolWhatsappDelivery();\n", "", "sol whatsapp unregister");
index = mustRegex(index, /  await Promise\.all\(\[\n    whatsappManager\.stopAll\(\)\.catch\(\(\) => undefined\),\n    homeAssistantManager\.stopAll\(\)\.catch\(\(\) => undefined\),\n    codexAppServer\.stop\(\)\.catch\(\(\) => undefined\),\n  \]\);/, '  await codexAppServer.stop().catch(() => undefined);', "native shutdown");
await write("apps/server/src/index.ts", index);

let inputs = await read("apps/server/src/modules/inputs/routes.ts");
inputs = mustReplace(inputs, 'import { homeAssistantManager } from "../connectors/home-assistant/manager.js";\nimport { whatsappManager } from "../connectors/whatsapp/manager.js";\n', "", "input manager imports");
inputs = mustRegex(inputs, /\nfunction runtimeFor\(account: SourceAccountRecord\): Record<string, unknown> \| undefined \{[\s\S]*?\n\}\n/, "\n", "runtimeFor");
inputs = mustReplace(inputs, "        runtime: runtimeFor(account),\n", "", "runtime field");
inputs = mustRegex(inputs, /  if \(!action && request\.method === "DELETE"\) \{[\s\S]*?\n  \}\n\n  return false;/, `  if (!action && request.method === "DELETE") {\n    if ((account.authMode ?? "").startsWith("plugin:")) {\n      sendJson(response, 409, { error: "input_is_plugin_managed", hint: "Manage this account from its plugin." });\n      return true;\n    }\n    const deleted = await deleteSourceAccount(sourceAccountId, principal.householdId);\n    sendJson(response, deleted ? 200 : 404, { ok: deleted });\n    return true;\n  }\n\n  return false;`, "input delete");
await write("apps/server/src/modules/inputs/routes.ts", inputs);

let cfg = await read("apps/server/src/config.ts");
cfg = mustReplace(cfg, 'const googleClientId = optionalEnv("SOL_GOOGLE_CLIENT_ID");\nconst googleClientSecret = optionalEnv("SOL_GOOGLE_CLIENT_SECRET");\n', "", "google vars");
cfg = mustRegex(cfg, /\n  \/\/ Nexo is the default product\/runtime profile\.[\s\S]*?nexoLegacyConnectorsEnabled: booleanEnv\("NEXO_LEGACY_CONNECTORS", false\),\n/, "\n", "legacy config");
cfg = mustRegex(cfg, /\n  googleClientId,[\s\S]*?mercadoLibreSyncMs: integerEnv\("SOL_MERCADOLIBRE_SYNC_MS", 60 \* 60 \* 1000\),/, "", "native connector config");
cfg = mustReplace(cfg, '  whatsappNexoUrl: optionalEnv("WHATSAPP_NEXO_URL") ?? "http://127.0.0.1:3210",\n  whatsappNexoAutomationToken: optionalEnv("NEXO_AUTOMATION_TOKEN"),\n', "", "native whatsapp config");
await write("apps/server/src/config.ts", cfg);

console.log("SOL external inputs are now plugin-only");
