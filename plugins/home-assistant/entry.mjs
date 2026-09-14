import { SolPluginClient, STREMIO_MCP_TOOLS } from "./lib/sol-client.mjs";
import { installStremioLaunchGuard } from "./lib/stremio-launch-guard.mjs";
import { installStremioSmartPlayback } from "./lib/stremio-smart-playback.mjs";
import { installStremioAudienceClassifier } from "./lib/stremio-audience-classifier.mjs";
import { installStremioIndexedSelection } from "./lib/stremio-indexed-selection.mjs";
import { installStremioDebugging } from "./lib/stremio-debug.mjs";


installStremioLaunchGuard(SolPluginClient);
installStremioSmartPlayback(SolPluginClient, STREMIO_MCP_TOOLS);
// Indexed selection runs before audience classification so explicit/profile language
// intent is resolved through the account-wide native stream order.
installStremioIndexedSelection(SolPluginClient);
installStremioAudienceClassifier(SolPluginClient, STREMIO_MCP_TOOLS);
installStremioDebugging(SolPluginClient, STREMIO_MCP_TOOLS);
await import("./index.mjs");
