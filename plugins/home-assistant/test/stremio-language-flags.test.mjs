import test from "node:test";
import assert from "node:assert/strict";
import { chooseNativeStream } from "../lib/stremio-indexed-selection.mjs";

function stream(providerIndex, title) {
  return { providerIndex, stream: { title }, addon: { id: "torrentio", name: "Torrentio" } };
}

function slice(titles) {
  return [{
    addonId: "torrentio",
    addonName: "Torrentio",
    streams: titles.map((title, index) => stream(index, title))
  }];
}

test("Spain flag makes a multi-audio row eligible for Spanish selection", () => {
  const choice = chooseNativeStream(slice([
    "Movie 1080p English",
    "Multi Audio / 🇬🇧 / 🇪🇸 / 🇫🇷"
  ]), { language: "spanish", quality: "1080p" });
  assert.equal(choice.ok, true);
  assert.equal(choice.nativeIndex, 1);
});

test("Spanish ranking is Mexico, Latino label, other Latin flag, then Spain flag", () => {
  const titles = [
    "Movie 1080p 🇪🇸",
    "Movie 1080p 🇦🇷",
    "Movie 1080p LATAM",
    "Movie 1080p 🇲🇽"
  ];
  assert.equal(chooseNativeStream(slice(titles), { language: "spanish", quality: "1080p" }).nativeIndex, 3);

  const withoutMexico = titles.slice(0, 3);
  assert.equal(chooseNativeStream(slice(withoutMexico), { language: "spanish", quality: "1080p" }).nativeIndex, 2);

  const withoutLabels = titles.slice(0, 2);
  assert.equal(chooseNativeStream(slice(withoutLabels), { language: "spanish", quality: "1080p" }).nativeIndex, 1);
});
