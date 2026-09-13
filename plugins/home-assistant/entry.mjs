import { SolPluginClient, STREMIO_MCP_TOOLS } from "./lib/sol-client.mjs";
import { installHomeAssistantOnlyTvControl } from "./lib/ha-only-tv.mjs";
import { installHaRemoteCommandNormalization } from "./lib/ha-remote-normalize.mjs";
import { installStremioStableClick } from "./lib/stremio-stable-click.mjs";
import { installStremioLaunchGuard } from "./lib/stremio-launch-guard.mjs";
import { installStremioSmartPlayback } from "./lib/stremio-smart-playback.mjs";
import { installStremioSmartCompatibility } from "./lib/stremio-smart-compat.mjs";
import { installStremioDebugging } from "./lib/stremio-debug.mjs";

// HA-only TV control policy: never contact Android TV Satellite.
// Keep all remote key transport inside Home Assistant so a dead Satellite cannot
// stall DPAD/OK commands or queue retries before Home Assistant receives them.
process.env.HA_SOL_TV_ENABLED = "false";
process.env.HA_SOL_STREMIO_CENTER_TRANSPORT = "home_assistant";
process.env.HA_SOL_STREMIO_AUTOSELECT_STREAM = "false";

installHaRemoteCommandNormalization(SolPluginClient);
installHomeAssistantOnlyTvControl(SolPluginClient);
installStremioStableClick(SolPluginClient);
installStremioLaunchGuard(SolPluginClient);
installStremioSmartPlayback(SolPluginClient, STREMIO_MCP_TOOLS);
installStremioSmartCompatibility(SolPluginClient);
installStremioDebugging(SolPluginClient, STREMIO_MCP_TOOLS);
await import("./index.mjs");
