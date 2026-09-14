import test from "node:test";
import assert from "node:assert/strict";
import { inspectStream, summarizeRankedStream } from "../lib/stremio-addons.mjs";

test("inspects only fields used by native stream selection", () => {
  const details = inspectStream({ title: "The Matrix 1080p Español Latino CAM" });
  assert.equal(details.quality, 1080);
  assert.deepEqual(details.languages, ["latin", "spanish"]);
  assert.equal(details.badSource, true);
});

test("summarizes native provider identity without ranking machinery", () => {
  const summary = summarizeRankedStream({
    addon: { id: "torrentio", name: "Torrentio" },
    providerIndex: 4,
    stream: { title: "Movie 4K English" }
  });
  assert.equal(summary.addonId, "torrentio");
  assert.equal(summary.providerIndex, 4);
  assert.equal(summary.resolution, 2160);
  assert.deepEqual(summary.languages, ["english"]);
});
