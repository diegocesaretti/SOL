import { SolPluginClient } from "./lib/sol-client.mjs";
import { installManualSpanishTitlePolicy } from "./lib/stremio-title-language-policy.mjs";

const manualSpanishPolicyEnabled = /^(1|true|yes|on)$/i.test(
  String(process.env.HA_SOL_STREMIO_MANUAL_SPANISH_POLICY || "")
);

if (manualSpanishPolicyEnabled) {
  installManualSpanishTitlePolicy(SolPluginClient, process.env);
}

await import("./index.mjs");
