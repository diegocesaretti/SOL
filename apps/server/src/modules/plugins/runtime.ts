import { resolve } from "node:path";
import { config } from "../../config.js";
import { SafePluginManager } from "./safe-manager.js";

const pluginHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;

export const pluginPackageMaxBytes = 256 * 1024 * 1024;

export const pluginManager = new SafePluginManager({
  rootDir: resolve(config.dataDir, "plugins"),
  coreUrl: `http://${pluginHost}:${config.port}`,
  maxPackageBytes: pluginPackageMaxBytes,
});

void pluginManager.startEnabled().catch((error) => {
  console.error("SOL plugin autostart failed", error);
});

let stopping = false;
function stopPlugins(): void {
  if (stopping) return;
  stopping = true;
  void pluginManager.shutdown().catch((error) => console.error("SOL plugin shutdown failed", error));
}

process.on("SIGINT", stopPlugins);
process.on("SIGTERM", stopPlugins);
