import { readFile, writeFile } from "node:fs/promises";

const path = "apps/server/src/modules/plugins/manager.ts";
let text = await readFile(path, "utf8");
const anchor = '    pluginEnv.SOL_PLUGIN_ID = plugin.manifest.id;\n    pluginEnv.SOL_PLUGIN_ROOT = plugin.directory;\n';
const replacement = '    const pluginDataDir = resolve(this.rootDir, "..", "plugin-data", plugin.manifest.id);\n    await mkdir(pluginDataDir, { recursive: true });\n    pluginEnv.SOL_PLUGIN_ID = plugin.manifest.id;\n    pluginEnv.SOL_PLUGIN_ROOT = plugin.directory;\n    pluginEnv.SOL_PLUGIN_DATA_DIR = pluginDataDir;\n';
if (!text.includes(replacement)) {
  if (!text.includes(anchor)) throw new Error("Plugin environment anchor not found");
  text = text.replace(anchor, replacement);
  await writeFile(path, text, "utf8");
  console.log("Added persistent SOL_PLUGIN_DATA_DIR");
}
