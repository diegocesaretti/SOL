import test from "node:test";
import assert from "node:assert/strict";
import {
  configuredOpenToKeysDelayMs,
  installStremioOpenToKeysDelay
} from "../lib/stremio-open-to-keys-delay.mjs";

class FakeClient {
  constructor(env = {}) {
    this.env = env;
    this.stremioTvEnabled = false;
    this.stremioTvUrl = "";
  }

  stremioStatus() {
    return { ok: true };
  }

  async waitForStreamUi() {
    return { ready: true, via: "original_wait", waitedMs: 999 };
  }

  async handleStremioTool(_tool, _args = {}) {
    return this.waitForStreamUi();
  }
}

installStremioOpenToKeysDelay(FakeClient);

test("open-to-keys delay defaults to 1500 ms and clamps to the configured range", () => {
  assert.equal(configuredOpenToKeysDelayMs({}), 1500);
  assert.equal(configuredOpenToKeysDelayMs({ HA_SOL_STREMIO_OPEN_TO_KEYS_DELAY_MS: "1750" }), 1750);
  assert.equal(configuredOpenToKeysDelayMs({ HA_SOL_STREMIO_OPEN_TO_KEYS_DELAY_MS: "-10" }), 0);
  assert.equal(configuredOpenToKeysDelayMs({ HA_SOL_STREMIO_OPEN_TO_KEYS_DELAY_MS: "99999" }), 15000);
});

test("Latin playback uses the independent open-to-keys delay instead of the normal stream delay", async () => {
  const client = new FakeClient({ HA_SOL_STREMIO_OPEN_TO_KEYS_DELAY_MS: "0" });
  const result = await client.handleStremioTool("home_assistant_stremio_play_best", { language: "latin" });

  assert.equal(result.ready, true);
  assert.equal(result.via, "configurable_open_to_keys_delay");
  assert.equal(result.waitedMs, 0);
  assert.equal(result.openToKeysDelayMs, 0);
});

test("normal playback keeps the pre-existing wait path", async () => {
  const client = new FakeClient({ HA_SOL_STREMIO_OPEN_TO_KEYS_DELAY_MS: "0" });
  const result = await client.handleStremioTool("home_assistant_stremio_play_best", { language: "any" });

  assert.equal(result.via, "original_wait");
  assert.equal(result.waitedMs, 999);
});

test("legacy indexed context also receives the configurable delay", async () => {
  const client = new FakeClient({ HA_SOL_STREMIO_OPEN_TO_KEYS_DELAY_MS: "0" });
  client.__stremioIndexedSelectionContext = { active: true };
  const result = await client.waitForStreamUi();

  assert.equal(result.via, "configurable_open_to_keys_delay");
});
