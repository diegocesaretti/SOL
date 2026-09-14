import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseNativeLanguageStream,
  executeIndexedSelection,
  indexedNavigationTiming,
  planFromProviderSlices,
  requiresExactLanguageSelection
} from "../lib/stremio-indexed-selection.mjs";

function stream(providerIndex, title) {
  return {
    providerIndex,
    stream: { title },
    addon: { id: "test", name: "Test" }
  };
}

test("searches every account provider and keeps the native Stremio index", () => {
  const slices = [
    {
      addonId: "torrentio",
      addonName: "Torrentio",
      streams: [stream(0, "Movie 1080p English"), stream(1, "Movie 720p English")]
    },
    {
      addonId: "mediafusion",
      addonName: "MediaFusion",
      streams: [stream(0, "Movie 1080p English"), stream(1, "Movie 1080p Latino")]
    }
  ];

  const choice = chooseNativeLanguageStream(slices, { language: "latin" });
  assert.equal(choice.ok, true);
  assert.equal(choice.nativeIndex, 3);
  assert.equal(choice.selected.addonId, "mediafusion");
  assert.equal(choice.selected.providerIndex, 1);
  assert.deepEqual(choice.selected.languages, ["latin"]);

  const plan = planFromProviderSlices(slices, choice.selected);
  assert.equal(plan.ok, true);
  assert.equal(plan.index, 3);
  assert.equal(plan.navigation, "horizontal_right");
});

test("explicit quality narrows Latin candidates without changing their native index", () => {
  const slices = [{
    addonId: "latino.provider",
    addonName: "Latino",
    streams: [
      stream(0, "Movie 720p Latino"),
      stream(1, "Movie 1080p Latino"),
      stream(2, "Movie 4K Latino")
    ]
  }];

  const choice = chooseNativeLanguageStream(slices, { language: "latin", quality: "1080p" });
  assert.equal(choice.ok, true);
  assert.equal(choice.nativeIndex, 1);
  assert.equal(choice.selected.resolution, 1080);
});

test("Spanish accepts Spanish or Latin while Latin remains strict", () => {
  const slices = [{
    addonId: "mixed.provider",
    addonName: "Mixed",
    streams: [stream(0, "Movie Spanish Castellano"), stream(1, "Movie Latino")]
  }];

  const latin = chooseNativeLanguageStream(slices, { language: "latin" });
  assert.equal(latin.ok, true);
  assert.equal(latin.nativeIndex, 1);

  const spanish = chooseNativeLanguageStream(slices, { language: "spanish" });
  assert.equal(spanish.ok, true);
  assert.equal(spanish.nativeIndex, 0);
});

test("fails closed when an earlier provider query is uncertain", () => {
  const plan = planFromProviderSlices([
    { addonId: "first.provider", streams: [], error: "timeout" },
    { addonId: "latino.provider", streams: [stream(0, "Latino")] }
  ], {
    addonId: "latino.provider",
    providerIndex: 0,
    languages: ["latin"]
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "stremio_index_provider_query_failed");
});

test("requires exact selection for explicit or detected Spanish/Latin streams", () => {
  assert.equal(requiresExactLanguageSelection({ languages: ["english"] }, { language: "latin" }), true);
  assert.equal(requiresExactLanguageSelection({ languages: ["spanish"] }, { language: "any" }), true);
  assert.equal(requiresExactLanguageSelection({ languages: ["english"] }, { language: "any" }), false);
});

test("compensates the initial Stremio focus before sending DPAD_CENTER", async () => {
  const seen = [];
  const client = {
    stremioRemoteEntityId: "remote.tv_cocina",
    async haService(domain, service, payload) {
      seen.push({ domain, service, payload });
      return { ok: true };
    }
  };

  const result = await executeIndexedSelection(client, {
    ok: true,
    index: 3,
    addonId: "latino.provider",
    providerIndex: 1
  }, { keyDelayMs: 0, initialFocusIndex: 1, centerDelayMs: 0, centerCommand: "DPAD_CENTER", centerHoldMs: 120 });

  assert.equal(result.ok, true);
  assert.equal(result.navigation, "horizontal_right");
  assert.equal(result.targetIndex, 3);
  assert.equal(result.initialFocusIndex, 1);
  assert.equal(result.suppressedRights, 1);
  assert.equal(result.forwardedRights, 2);
  assert.equal(result.centerSent, true);
  assert.deepEqual(result.commands, ["DPAD_RIGHT", "DPAD_RIGHT", "DPAD_CENTER"]);
  assert.deepEqual(seen.map((entry) => entry.payload.command), [
    ["DPAD_RIGHT"],
    ["DPAD_RIGHT"],
    "DPAD_CENTER"
  ]);
  assert.equal(seen[2].payload.hold_secs, 0.12);
  assert.ok(seen.every((entry) => entry.domain === "remote" && entry.service === "send_command"));
});

test("rejects indexes above the configured safety cap", () => {
  const streams = Array.from({ length: 35 }, (_, providerIndex) => stream(providerIndex, `Movie ${providerIndex} Latino`));
  const plan = planFromProviderSlices([
    { addonId: "latino.provider", streams }
  ], {
    addonId: "latino.provider",
    providerIndex: 34,
    languages: ["latin"]
  }, { maxIndex: 30 });

  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "stremio_index_exceeds_safe_limit");
  assert.equal(plan.index, 34);
});

test("moves left when the target is before the configured initial focus", async () => {
  const seen = [];
  const client = {
    stremioRemoteEntityId: "remote.tv_cocina",
    async haService(_domain, _service, payload) {
      seen.push(Array.isArray(payload.command) ? payload.command[0] : payload.command);
      return { ok: true };
    }
  };
  const result = await executeIndexedSelection(client, { ok: true, index: 0 }, {
    keyDelayMs: 0,
    initialFocusIndex: 1,
    centerDelayMs: 0,
    centerCommand: "DPAD_CENTER",
    centerHoldMs: 120
  });
  assert.equal(result.ok, true);
  assert.equal(result.navigation, "horizontal_left");
  assert.equal(result.injectedLefts, 1);
  assert.deepEqual(seen, ["DPAD_LEFT", "DPAD_CENTER"]);
});

test("indexed timing accepts up to 60 seconds before navigation", () => {
  const timing = indexedNavigationTiming({
    HA_SOL_STREMIO_OPEN_TO_KEYS_DELAY_MS: "45000",
    HA_SOL_STREMIO_INDEXED_KEY_DELAY_MS: "500",
    HA_SOL_STREMIO_INDEXED_INITIAL_FOCUS_INDEX: "1",
    HA_SOL_STREMIO_INDEXED_CENTER_DELAY_MS: "1200",
    HA_SOL_STREMIO_INDEXED_CENTER_COMMAND: "ENTER",
    HA_SOL_STREMIO_INDEXED_CENTER_HOLD_MS: "180"
  });
  assert.deepEqual(timing, {
    openToKeysDelayMs: 45000,
    keyDelayMs: 500,
    initialFocusIndex: 1,
    centerDelayMs: 1200,
    centerCommand: "ENTER",
    centerHoldMs: 180
  });
});

test("can send ENTER as the indexed select key with an atomic hold", async () => {
  const seen = [];
  const client = {
    stremioRemoteEntityId: "remote.tv_cocina",
    async haService(_domain, _service, payload) {
      seen.push(payload);
      return { ok: true };
    }
  };
  const result = await executeIndexedSelection(client, { ok: true, index: 1 }, {
    keyDelayMs: 0,
    initialFocusIndex: 1,
    centerDelayMs: 0,
    centerCommand: "ENTER",
    centerHoldMs: 200
  });
  assert.equal(result.ok, true);
  assert.equal(result.centerSent, true);
  assert.equal(result.centerCommand, "ENTER");
  assert.equal(result.centerHoldMs, 200);
  assert.deepEqual(seen, [{
    entity_id: "remote.tv_cocina",
    command: "ENTER",
    hold_secs: 0.2
  }]);
});
