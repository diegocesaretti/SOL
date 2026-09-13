import test from "node:test";
import assert from "node:assert/strict";
import { streamAddonOptions } from "../lib/stremio-account-options-server.mjs";
import { __test as providerTest } from "../lib/stremio-family-account-provider.mjs";

test("account options expose only safe stream addon ids and labels", () => {
  const addons = [
    {
      id: "com.example.latino",
      name: "Latino Plus",
      roles: ["stream"],
      transportUrl: "https://private.example.invalid/secret/manifest.json"
    },
    {
      id: "com.example.subtitles",
      name: "Subtitle only",
      roles: ["subtitle"],
      transportUrl: "https://private.example.invalid/subtitles/manifest.json"
    }
  ];
  const options = streamAddonOptions(addons);
  assert.deepEqual(options, [
    { value: "com.example.latino", label: "Latino Plus · com.example.latino" }
  ]);
  assert.equal(JSON.stringify(options).includes("private.example.invalid"), false);
});

test("selected family addon must be the exact stream addon id", () => {
  const addons = [
    {
      id: "com.example.latino",
      name: "Latino Plus",
      roles: ["stream"],
      transportUrl: "https://private.example.invalid/latino/manifest.json"
    },
    {
      id: "com.example.other",
      name: "Other",
      roles: ["stream"],
      transportUrl: "https://private.example.invalid/other/manifest.json"
    }
  ];
  const selected = providerTest.findSelectedStreamAddon(addons, "com.example.latino");
  assert.equal(selected?.id, "com.example.latino");
  assert.equal(providerTest.findSelectedStreamAddon(addons, "com.missing"), null);
});

test("manual selection leaves the existing family manifest path untouched", () => {
  assert.equal(providerTest.selectedAddonId({ HA_SOL_STREMIO_FAMILY_ACCOUNT_ADDON_ID: "manual" }), "");
  assert.equal(providerTest.selectedAddonId({ HA_SOL_STREMIO_FAMILY_ACCOUNT_ADDON_ID: "" }), "");
  assert.equal(providerTest.selectedAddonId({ HA_SOL_STREMIO_FAMILY_ACCOUNT_ADDON_ID: "com.example.latino" }), "com.example.latino");
});
