import { SolPluginClient, STREMIO_MCP_TOOLS } from "./lib/sol-client.mjs";
import { installStremioStableClick } from "./lib/stremio-stable-click.mjs";
import { installStremioLaunchGuard } from "./lib/stremio-launch-guard.mjs";
import { installStremioDebugging } from "./lib/stremio-debug.mjs";

installStremioStableClick(SolPluginClient);
installStremioLaunchGuard(SolPluginClient);
installStremioDebugging(SolPluginClient, STREMIO_MCP_TOOLS);
await import("./index.mjs");
