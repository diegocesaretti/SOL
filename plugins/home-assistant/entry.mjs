import { SolPluginClient } from "./lib/sol-client.mjs";
import { installStremioLaunchGuard } from "./lib/stremio-launch-guard.mjs";

installStremioLaunchGuard(SolPluginClient);
await import("./index.mjs");
