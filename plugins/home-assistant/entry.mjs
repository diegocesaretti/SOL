import { SolPluginClient, STREMIO_MCP_TOOLS } from "./lib/sol-client.mjs";
import { installStremioLaunchGuard } from "./lib/stremio-launch-guard.mjs";
import { installStremioDebugging } from "./lib/stremio-debug.mjs";

installStremioLaunchGuard(SolPluginClient);
installStremioDebugging(SolPluginClient, STREMIO_MCP_TOOLS);
await import("./index.mjs");
