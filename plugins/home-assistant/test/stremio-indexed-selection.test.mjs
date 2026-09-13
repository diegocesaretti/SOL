import test from "node:test";
import assert from "node:assert/strict";
import {
  executeIndexedSelection,
  planFromProviderSlices,
  requiresExactLanguageSelection
} from "../lib/stremio-indexed-selection.mjs";

test("builds absolute Stremio row index from addon order and providerIndex", () => {
  const plan = planFromProviderSlices([
    {
      addonId: "english.provider",
      streams: [
        { providerIndex: 0 },
        { providerIndex: 1 }
      ]
    },
    {
      addonId: "latino.provider",
      streams: [
        { providerIndex: 0 },
        { providerIndex: 1 },
        { providerIndex: 2 }
      ]
    }
  ], {
    addonId: "latino.provider",
    providerIndex: 1,
    languages: ["latin"]
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.index, 3);
  assert.equal(plan.streamsBefore, 2);
  assert.equal(plan.providerIndex, 1);
});

test("fails closed when an earlier provider query is uncertain", () => {
  const plan = planFromProviderSlices([
    { addonId: "first.provider", streams: [], error: "timeout" },
    { addonId: "latino.provider", streams: [{ providerIndex: 0 }] }
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

test("sends one Home Assistant DPAD_DOWN per row then DPAD_CENTER", async () => {
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
  assert.deepEqual(result.commands, ["DPAD_DOWN", "DPAD_DOWN", "DPAD_DOWN", "DPAD_CENTER"]);
  assert.deepEqual(seen.map((entry) => entry.payload.command), [
    ["DPAD_DOWN"],
    ["DPAD_DOWN"],
    ["DPAD_DOWN"],
    ["DPAD_CENTER"]
  ]);
  assert.ok(seen.every((entry) => entry.domain === "remote" && entry.service === "send_command"));
});

test("rejects indexes above the configured safety cap", () => {
  const streams = Array.from({ length: 35 }, (_, providerIndex) => ({ providerIndex }));
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
