import test from "node:test";
import assert from "node:assert/strict";
import { inspectStream, summarizeRankedStream } from "../lib/stremio-addons.mjs";

test("inspects only fields used by native stream selection", () => {
  const details = inspectStream({ title: "The Matrix 1080p Español Latino CAM" });
  assert.equal(details.quality, 1080);
  assert.equal(details.audioType, "single");
  assert.deepEqual(details.audioLanguages, ["spanish"]);
  assert.equal(details.spanishVariant, "latin");
  assert.deepEqual(details.languages, ["latin", "spanish"]);
  assert.equal(details.badSource, true);
});

test("normalizes Stremio Multi Audio flags preserving provider display order", () => {
  const details = inspectStream({ title: "Multi Audio / 🇬🇧 / 🇪🇸 / 🇫🇷" });
  assert.equal(details.audioType, "multi");
  assert.deepEqual(details.audioLanguages, ["english", "spanish", "french"]);
  assert.equal(details.spanishVariant, null);
  assert.deepEqual(details.languages, ["english", "spanish", "french"]);
  assert.equal(details.latinPriority, 0);
  assert.equal(details.latinSignal, null);
});

test("infers multi audio from multiple language flags even without a Multi Audio label", () => {
  const details = inspectStream({ title: "Movie 1080p 🇺🇸 / 🇪🇸" });
  assert.equal(details.audioType, "multi");
  assert.deepEqual(details.audioLanguages, ["english", "spanish"]);
});

test("keeps Latino ranking signals ordered Mexico, explicit Latino, other Latin flags", () => {
  const mexico = inspectStream({ title: "Movie 1080p 🇲🇽" });
  const explicitLatino = inspectStream({ title: "Movie 1080p LATAM" });
  const argentina = inspectStream({ title: "Movie 1080p 🇦🇷" });
  const spain = inspectStream({ title: "Movie 1080p 🇪🇸" });

  assert.deepEqual(mexico.audioLanguages, ["spanish"]);
  assert.deepEqual(mexico.languages, ["latin", "spanish"]);
  assert.equal(mexico.spanishVariant, "latin");
  assert.equal(mexico.latinPriority, 3);
  assert.equal(mexico.latinSignal, "mexico_flag");
  assert.equal(explicitLatino.latinPriority, 2);
  assert.equal(explicitLatino.latinSignal, "latin_label");
  assert.equal(argentina.latinPriority, 1);
  assert.equal(argentina.latinSignal, "latin_flag");
  assert.deepEqual(spain.audioLanguages, ["spanish"]);
  assert.deepEqual(spain.languages, ["spanish"]);
  assert.equal(spain.spanishVariant, null);
  assert.equal(spain.latinPriority, 0);
});

test("summarizes structured audio metadata with native provider identity", () => {
  const summary = summarizeRankedStream({
    addon: { id: "torrentio", name: "Torrentio" },
    providerIndex: 4,
    stream: { title: "Movie 4K Multi Audio / 🇬🇧 / 🇪🇸 / 🇫🇷" }
  });
  assert.equal(summary.addonId, "torrentio");
  assert.equal(summary.providerIndex, 4);
  assert.equal(summary.resolution, 2160);
  assert.equal(summary.audioType, "multi");
  assert.deepEqual(summary.audioLanguages, ["english", "spanish", "french"]);
  assert.equal(summary.spanishVariant, null);
});
