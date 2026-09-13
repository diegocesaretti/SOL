import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseNativeLanguageStream,
  executeIndexedSelection,
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

test("sends one Home Assistant DPAD_RIGHT per native position then DPAD_CENTER", async () => {
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
  }, { keyDelayMs: 0 });

  assert.equal(result.ok, true);
  assert.equal(result.navigation, "horizontal_right");
  assert.deepEqual(result.commands, ["DPAD_RIGHT", "DPAD_RIGHT", "DPAD_RIGHT", "DPAD_CENTER"]);
  assert.deepEqual(seen.map((entry) => entry.payload.command), [
    ["DPAD_RIGHT"],
    ["DPAD_RIGHT"],
    ["DPAD_RIGHT"],
    ["DPAD_CENTER"]
  ]);
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
