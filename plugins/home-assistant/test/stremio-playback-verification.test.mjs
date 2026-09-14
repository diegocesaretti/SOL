import test from "node:test";
import assert from "node:assert/strict";
import { SolPluginClient, STREMIO_MCP_TOOLS } from "../lib/sol-client.mjs";

test("HA-only playback verification is transport-only and never depends on screenshots", async () => {
  const client = new SolPluginClient({});
  const result = await client.verifyPlayback();
  assert.equal(result.status, "unverified");
  assert.equal(result.confirmed, null);
  assert.equal(result.via, "home_assistant_transport_only");
  assert.equal(result.screenshotRequired, false);
});

test("retired selector tools and override are no longer exposed", () => {
  const names = STREMIO_MCP_TOOLS.map((tool) => tool.name);
  assert.equal(names.includes("home_assistant_stremio_proxy_status"), false);
  assert.equal(names.includes("home_assistant_stremio_proxy_install"), false);
  const playBest = STREMIO_MCP_TOOLS.find((tool) => tool.name === "home_assistant_stremio_play_best");
  assert.ok(playBest);
  assert.equal(Object.hasOwn(playBest.inputSchema.properties, "useSelectorProxy"), false);
  assert.match(playBest.description, /standard Play Store Stremio native stream list/i);
});

test("status reports native-only playback", () => {
  const client = new SolPluginClient({});
  const status = client.stremioStatus();
  assert.equal(status.playbackMode, "native_stremio_only");
  assert.equal(Object.hasOwn(status, "selectorProxy"), false);
  assert.equal(status.capabilities.publicHttpsSelectorRequired, false);
  assert.equal(status.capabilities.nativeInstalledAddonPlayback, true);
});