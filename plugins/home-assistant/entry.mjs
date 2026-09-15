import { SolPluginClient } from "./lib/sol-client.mjs";
import { installManualSpanishTitlePolicy } from "./lib/stremio-title-language-policy.mjs";

installManualSpanishTitlePolicy(SolPluginClient, process.env);
await import("./index.mjs");
