import test from "node:test";
import assert from "node:assert/strict";
import { inspectStream, summarizeRankedStream } from "../lib/stremio-addons.mjs";

test("inspects only fields used by native stream selection", () => {
  const details = inspectStream({ title: "The Matrix 1080p Español Latino CAM" });
  assert.equal(details.quality, 1080);
  assert.deepEqual(details.languages, ["latin", "spanish"]);
  assert.equal(details.badSource, true);
});

test("detects Stremio multi-audio flags such as the Spain flag from provider text", () => {
  const details = inspectStream({ title: "Multi Audio / 🇬🇧 / 🇪🇸 / 🇫🇷" });
  assert.deepEqual(details.languages, ["spanish", "english"]);
  assert.equal(details.latinPriority, 0);
  assert.equal(details.latinSignal, null);
});

test("keeps Latino ranking signals ordered Mexico, explicit Latino, other Latin flags", () => {
  const mexico = inspectStream({ title: "Movie 1080p 🇲🇽" });
  const explicitLatino = inspectStream({ title: "Movie 1080p LATAM" });
  const argentina = inspectStream({ title: "Movie 1080p 🇦🇷" });
  const spain = inspectStream({ title: "Movie 1080p 🇪🇸" });

  assert.deepEqual(mexico.languages, ["latin"]);
  assert.equal(mexico.latinPriority, 3);
  assert.equal(mexico.latinSignal, "mexico_flag");
  assert.equal(explicitLatino.latinPriority, 2);
  assert.equal(explicitLatino.latinSignal, "latin_label");
  assert.equal(argentina.latinPriority, 1);
  assert.equal(argentina.latinSignal, "latin_flag");
  assert.deepEqual(spain.languages, ["spanish"]);
  assert.equal(spain.latinPriority, 0);
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
