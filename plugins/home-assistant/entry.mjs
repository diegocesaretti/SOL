import { SolPluginClient, STREMIO_MCP_TOOLS } from "./lib/sol-client.mjs";
import { installStremioStableClick } from "./lib/stremio-stable-click.mjs";
import { installStremioLaunchGuard } from "./lib/stremio-launch-guard.mjs";
import { installStremioSmartPlayback } from "./lib/stremio-smart-playback.mjs";
import { installStremioDebugging } from "./lib/stremio-debug.mjs";

installStremioStableClick(SolPluginClient);
installStremioLaunchGuard(SolPluginClient);
installStremioSmartPlayback(SolPluginClient, STREMIO_MCP_TOOLS);
installStremioDebugging(SolPluginClient, STREMIO_MCP_TOOLS);
await import("./index.mjs");
