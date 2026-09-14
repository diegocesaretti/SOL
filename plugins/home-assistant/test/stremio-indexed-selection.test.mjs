import test from "node:test";
import assert from "node:assert/strict";
import {
  accountAddonSupportsStream,
  chooseNativeStream,
  executeIndexedSelection,
  indexedNavigationTiming,
  planFromProviderSlices
} from "../lib/stremio-indexed-selection.mjs";

function stream(providerIndex, title) {
  return { providerIndex, stream: { title }, addon: { id: "test", name: "Test" } };
}

test("keeps absolute native Stremio index across account providers", () => {
  const slices = [
    { addonId: "torrentio", addonName: "Torrentio", streams: [stream(0, "Movie 1080p English"), stream(1, "Movie 720p English")] },
    { addonId: "mediafusion", addonName: "MediaFusion", streams: [stream(0, "Movie 1080p English"), stream(1, "Movie 1080p Latino")] }
  ];
  const choice = chooseNativeStream(slices, { language: "latin", quality: "1080p" });
  assert.equal(choice.ok, true);
  assert.equal(choice.nativeIndex, 3);
  assert.equal(choice.selected.addonId, "mediafusion");
  assert.equal(choice.selected.providerIndex, 1);
  const plan = planFromProviderSlices(slices, choice.selected);
  assert.equal(plan.ok, true);
  assert.equal(plan.index, 3);
});

test("mirrors Stremio manifest type and id-prefix eligibility before counting provider rows", () => {
  const addon = {
    manifest: {
      types: ["movie"],
      resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }]
    }
  };
  assert.equal(accountAddonSupportsStream(addon, "movie", "tt0133093"), true);
  assert.equal(accountAddonSupportsStream(addon, "series", "tt0903747:1:1"), false);
  assert.equal(accountAddonSupportsStream(addon, "movie", "kitsu:123"), false);
});

test("default quality selects 1080p without changing native index", () => {
  const slices = [{ addonId: "latino.provider", addonName: "Latino", streams: [stream(0, "Movie 720p Latino"), stream(1, "Movie 1080p Latino"), stream(2, "Movie 4K Latino")] }];
  const choice = chooseNativeStream(slices, { language: "latin", quality: "1080p" });
  assert.equal(choice.ok, true);
  assert.equal(choice.nativeIndex, 1);
  assert.equal(choice.selected.resolution, 1080);
});

test("Spanish accepts Spanish or Latin while Latin remains strict", () => {
  const slices = [{ addonId: "mixed.provider", addonName: "Mixed", streams: [stream(0, "Movie Spanish Castellano"), stream(1, "Movie Latino")] }];
  assert.equal(chooseNativeStream(slices, { language: "latin" }).nativeIndex, 1);
  assert.equal(chooseNativeStream(slices, { language: "spanish" }).nativeIndex, 0);
});

test("any language still uses the single native-index path", () => {
  const slices = [{ addonId: "provider", addonName: "Provider", streams: [stream(0, "Movie 720p"), stream(1, "Movie 1080p")] }];
  const choice = chooseNativeStream(slices, { language: "any", quality: "1080p" });
  assert.equal(choice.ok, true);
  assert.equal(choice.nativeIndex, 1);
});

test("fails closed when an earlier provider query is uncertain", () => {
  const plan = planFromProviderSlices([
    { addonId: "first.provider", streams: [], error: "timeout" },
    { addonId: "latino.provider", streams: [stream(0, "Latino")] }
  ], { addonId: "latino.provider", providerIndex: 0 });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "stremio_index_provider_query_failed");
});

test("sends every movement in its own HA call and the final select atomically", async () => {
  const seen = [];
  const client = {
    stremioRemoteEntityId: "remote.tv_cocina",
    async haService(domain, service, payload) { seen.push({ domain, service, payload }); return { ok: true }; }
  };
  const result = await executeIndexedSelection(client, { ok: true, index: 3, addonId: "latino.provider", providerIndex: 1 }, {
    keyDelayMs: 0, initialFocusIndex: 1, centerDelayMs: 0, centerCommand: "DPAD_CENTER", centerHoldMs: 120
  });
  assert.equal(result.ok, true);
  assert.equal(result.movementCount, 2);
  assert.equal(result.centerSent, true);
  assert.deepEqual(result.commands, ["DPAD_RIGHT", "DPAD_RIGHT", "DPAD_CENTER"]);
  assert.deepEqual(seen.map((entry) => entry.payload.command), [["DPAD_RIGHT"], ["DPAD_RIGHT"], "DPAD_CENTER"]);
  assert.equal(seen[2].payload.hold_secs, 0.12);
});

test("moves left when target is before initial focus", async () => {
  const seen = [];
  const client = { stremioRemoteEntityId: "remote.tv_cocina", async haService(_domain, _service, payload) { seen.push(payload.command); return { ok: true }; } };
  const result = await executeIndexedSelection(client, { ok: true, index: 0 }, { keyDelayMs: 0, initialFocusIndex: 1, centerDelayMs: 0, centerCommand: "DPAD_CENTER", centerHoldMs: 120 });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, [["DPAD_LEFT"], "DPAD_CENTER"]);
});

test("timing supports long startup delay and independent select timing", () => {
  const timing = indexedNavigationTiming({
    HA_SOL_STREMIO_OPEN_TO_KEYS_DELAY_MS: "45000",
    HA_SOL_STREMIO_INDEXED_KEY_DELAY_MS: "500",
    HA_SOL_STREMIO_INDEXED_INITIAL_FOCUS_INDEX: "1",
    HA_SOL_STREMIO_INDEXED_CENTER_DELAY_MS: "1200",
    HA_SOL_STREMIO_INDEXED_CENTER_COMMAND: "ENTER",
    HA_SOL_STREMIO_INDEXED_CENTER_HOLD_MS: "180"
  });
  assert.deepEqual(timing, { openToKeysDelayMs: 45000, keyDelayMs: 500, initialFocusIndex: 1, centerDelayMs: 1200, centerCommand: "ENTER", centerHoldMs: 180 });
});

test("rejects indexes above the safety cap", () => {
  const streams = Array.from({ length: 35 }, (_, providerIndex) => stream(providerIndex, `Movie ${providerIndex} Latino`));
  const plan = planFromProviderSlices([{ addonId: "latino.provider", streams }], { addonId: "latino.provider", providerIndex: 34 }, { maxIndex: 30 });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "stremio_index_exceeds_safe_limit");
});
