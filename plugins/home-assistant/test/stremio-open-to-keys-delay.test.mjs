import test from "node:test";
import assert from "node:assert/strict";
import {
  configuredIndexedCenterDelayMs,
  configuredIndexedInitialFocusIndex,
  configuredOpenToKeysDelayMs,
  installStremioOpenToKeysDelay
} from "../lib/stremio-open-to-keys-delay.mjs";

class FakeClient {
  constructor(env = {}) {
    this.env = env;
    this.stremioTvEnabled = false;
    this.stremioTvUrl = "";
    this.seen = [];
  }

  stremioStatus() {
    return { ok: true };
  }

  async waitForStreamUi() {
    return { ready: true, via: "original_wait", waitedMs: 999 };
  }

  async haService(domain, service, payload) {
    this.seen.push({ domain, service, payload });
    return { ok: true };
  }

  async handleStremioTool(_tool, args = {}) {
    const readiness = await this.waitForStreamUi();
    for (const command of Array.isArray(args.__commands) ? args.__commands : []) {
      await this.haService("remote", "send_command", {
        entity_id: "remote.tv_cocina",
        command: [command]
      });
    }
    return Array.isArray(args.__commands) ? { ok: true, readiness } : readiness;
  }
}

installStremioOpenToKeysDelay(FakeClient);

test("open-to-keys delay defaults to 1500 ms and now allows up to 60 seconds", () => {
  assert.equal(configuredOpenToKeysDelayMs({}), 1500);
  assert.equal(configuredOpenToKeysDelayMs({ HA_SOL_STREMIO_OPEN_TO_KEYS_DELAY_MS: "1750" }), 1750);
  assert.equal(configuredOpenToKeysDelayMs({ HA_SOL_STREMIO_OPEN_TO_KEYS_DELAY_MS: "-10" }), 0);
  assert.equal(configuredOpenToKeysDelayMs({ HA_SOL_STREMIO_OPEN_TO_KEYS_DELAY_MS: "45000" }), 45000);
  assert.equal(configuredOpenToKeysDelayMs({ HA_SOL_STREMIO_OPEN_TO_KEYS_DELAY_MS: "99999" }), 60000);
});

test("indexed focus compensation defaults to Stremio already focused on index 1", () => {
  assert.equal(configuredIndexedInitialFocusIndex({}), 1);
  assert.equal(configuredIndexedInitialFocusIndex({ HA_SOL_STREMIO_INDEXED_INITIAL_FOCUS_INDEX: "0" }), 0);
  assert.equal(configuredIndexedInitialFocusIndex({ HA_SOL_STREMIO_INDEXED_INITIAL_FOCUS_INDEX: "99" }), 5);
});

test("center delay follows indexed key delay unless explicitly overridden", () => {
  assert.equal(configuredIndexedCenterDelayMs({}), 250);
  assert.equal(configuredIndexedCenterDelayMs({ HA_SOL_STREMIO_INDEXED_KEY_DELAY_MS: "600" }), 600);
  assert.equal(configuredIndexedCenterDelayMs({
    HA_SOL_STREMIO_INDEXED_KEY_DELAY_MS: "600",
    HA_SOL_STREMIO_INDEXED_CENTER_DELAY_MS: "900"
  }), 900);
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

test("compensates one extra initial-right and still sends CENTER", async () => {
  const client = new FakeClient({
    HA_SOL_STREMIO_OPEN_TO_KEYS_DELAY_MS: "0",
    HA_SOL_STREMIO_INDEXED_KEY_DELAY_MS: "0",
    HA_SOL_STREMIO_INDEXED_CENTER_DELAY_MS: "0",
    HA_SOL_STREMIO_INDEXED_INITIAL_FOCUS_INDEX: "1"
  });

  const result = await client.handleStremioTool("home_assistant_stremio_play_best", {
    language: "latin",
    __commands: ["DPAD_RIGHT", "DPAD_RIGHT", "DPAD_RIGHT", "DPAD_CENTER"]
  });

  assert.deepEqual(client.seen.map((entry) => entry.payload.command), [
    ["DPAD_RIGHT"],
    ["DPAD_RIGHT"],
    ["DPAD_CENTER"]
  ]);
  assert.equal(result.indexedNavigationAdjustment.requestedRights, 3);
  assert.equal(result.indexedNavigationAdjustment.suppressedRights, 1);
  assert.equal(result.indexedNavigationAdjustment.forwardedRights, 2);
  assert.equal(result.indexedNavigationAdjustment.centerSent, true);
});

test("can move LEFT to reach native index 0 when Stremio starts focused on index 1", async () => {
  const client = new FakeClient({
    HA_SOL_STREMIO_OPEN_TO_KEYS_DELAY_MS: "0",
    HA_SOL_STREMIO_INDEXED_KEY_DELAY_MS: "0",
    HA_SOL_STREMIO_INDEXED_CENTER_DELAY_MS: "0",
    HA_SOL_STREMIO_INDEXED_INITIAL_FOCUS_INDEX: "1"
  });

  const result = await client.handleStremioTool("home_assistant_stremio_play_best", {
    language: "latin",
    __commands: ["DPAD_CENTER"]
  });

  assert.deepEqual(client.seen.map((entry) => entry.payload.command), [
    ["DPAD_LEFT"],
    ["DPAD_CENTER"]
  ]);
  assert.equal(result.indexedNavigationAdjustment.injectedLefts, 1);
  assert.equal(result.indexedNavigationAdjustment.centerSent, true);
});
