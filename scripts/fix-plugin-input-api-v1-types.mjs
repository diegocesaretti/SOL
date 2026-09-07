import { readFile, writeFile } from "node:fs/promises";

const path = "apps/server/src/modules/ingestion/plugin-input-service.ts";
const before = await readFile(path, "utf8");
const after = before.replaceAll("principal: PluginRuntimePrincipal", "principal: SolPluginRuntimePrincipal");
if (after === before) {
  console.log("No remaining PluginRuntimePrincipal references to fix");
} else {
  await writeFile(path, after, "utf8");
  console.log("Fixed remaining plugin runtime principal type references");
}
