import test from "node:test";
import assert from "node:assert/strict";
import { inspectStream } from "../lib/stremio-addons.mjs";
import { chooseNativeStream } from "../lib/stremio-indexed-selection.mjs";

function slices(titles) {
  return [{
    addonId: "test.provider",
    addonName: "Test Provider",
    streams: titles.map((title, providerIndex) => ({
      addon: { id: "test.provider", name: "Test Provider" },
      providerIndex,
      stream: { title }
    }))
  }];
}

test("classifies Mexico flag above textual Latin labels", () => {
  const mexico = inspectStream({ title: "Movie 720p 🇲🇽" });
  const latino = inspectStream({ title: "Movie 1080p LATINO" });
  const argentina = inspectStream({ title: "Movie 4K 🇦🇷" });

  assert.deepEqual(mexico.languages, ["latin"]);
  assert.equal(mexico.latinPriority, 2);
  assert.equal(mexico.latinSignal, "mexico_flag");
  assert.equal(latino.latinPriority, 1);
  assert.equal(latino.latinSignal, "latin_label");
  assert.deepEqual(argentina.languages, ["latin"]);
  assert.equal(argentina.latinPriority, 0);
});

test("Mexico flag wins before requested quality", () => {
  const choice = chooseNativeStream(slices([
    "Movie 1080p Latino",
    "Movie 720p 🇲🇽"
  ]), { language: "latin", quality: "1080p" });

  assert.equal(choice.ok, true);
  assert.equal(choice.nativeIndex, 1);
  assert.equal(choice.selected.latinSignal, "mexico_flag");
  assert.equal(choice.selected.resolution, 720);
});

test("LAT or Latino wins before other Latin markers and then quality applies", () => {
  const choice = chooseNativeStream(slices([
    "Movie 2160p 🇦🇷",
    "Movie 720p LATAM",
    "Movie 1080p Latino"
  ]), { language: "latin", quality: "1080p" });

  assert.equal(choice.ok, true);
  assert.equal(choice.nativeIndex, 2);
  assert.equal(choice.selected.latinSignal, "latin_label");
  assert.equal(choice.selected.resolution, 1080);
});

test("without Mexico or Latin labels normal quality ranking still applies", () => {
  const choice = chooseNativeStream(slices([
    "Movie 720p 🇦🇷",
    "Movie 1080p 🇨🇴"
  ]), { language: "latin", quality: "1080p" });

  assert.equal(choice.ok, true);
  assert.equal(choice.nativeIndex, 1);
  assert.equal(choice.selected.resolution, 1080);
});
