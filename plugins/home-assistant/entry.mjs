import { SolPluginClient, STREMIO_MCP_TOOLS } from "./lib/sol-client.mjs";
import { installHomeAssistantOnlyTvControl } from "./lib/ha-only-tv.mjs";
import { installStremioStableClick } from "./lib/stremio-stable-click.mjs";
import { installStremioLaunchGuard } from "./lib/stremio-launch-guard.mjs";
import { installStremioSmartPlayback } from "./lib/stremio-smart-playback.mjs";
import { installStremioSmartCompatibility } from "./lib/stremio-smart-compat.mjs";
import { installStremioFamilyAccountProvider } from "./lib/stremio-family-account-provider.mjs";
import { installStremioAudienceClassifier } from "./lib/stremio-audience-classifier.mjs";
import { installStremioFamilyLanguagePolicy } from "./lib/stremio-family-language-policy.mjs";
import { startStremioAccountOptionsServer } from "./lib/stremio-account-options-server.mjs";
import { installStremioLegacyAutoclick } from "./lib/stremio-legacy-autoclick.mjs";
import { installStremioIndexedSelection } from "./lib/stremio-indexed-selection.mjs";
import { installStremioDebugging } from "./lib/stremio-debug.mjs";

// HA-only TV control policy: never contact Android TV Satellite.
// Keep all remote key transport inside Home Assistant so a dead Satellite cannot
// stall DPAD/OK commands or queue retries before Home Assistant receives them.
process.env.HA_SOL_TV_ENABLED = "false";
process.env.HA_SOL_STREMIO_CENTER_TRANSPORT = "home_assistant";
process.env.HA_SOL_STREMIO_AUTOSELECT_STREAM = "false";

startStremioAccountOptionsServer();
installHomeAssistantOnlyTvControl(SolPluginClient);
installStremioStableClick(SolPluginClient);
installStremioLaunchGuard(SolPluginClient);
installStremioSmartPlayback(SolPluginClient, STREMIO_MCP_TOOLS);
installStremioSmartCompatibility(SolPluginClient);
// Keep the old isolated provider adapter inside the new account-wide path so it
// remains available only as a backwards-compatible fallback.
installStremioFamilyAccountProvider(SolPluginClient);
// Install indexed selection before the audience wrappers. Audience classification
// can then map Kids/Family -> family, the language policy adds latin, and this
// selector receives that final intent before the legacy provider adapter.
installStremioIndexedSelection(SolPluginClient);
installStremioFamilyLanguagePolicy(SolPluginClient);
installStremioAudienceClassifier(SolPluginClient, STREMIO_MCP_TOOLS);
installStremioLegacyAutoclick(SolPluginClient);
installStremioDebugging(SolPluginClient, STREMIO_MCP_TOOLS);
await import("./index.mjs");
