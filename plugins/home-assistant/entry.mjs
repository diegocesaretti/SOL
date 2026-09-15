import { SolPluginClient } from "./lib/sol-client.mjs";
import { installManualLatinTitlePolicy } from "./lib/stremio-title-language-policy.mjs";

installManualLatinTitlePolicy(SolPluginClient, process.env);
await import("./index.mjs");
