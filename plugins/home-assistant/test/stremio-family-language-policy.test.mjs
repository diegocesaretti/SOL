import test from "node:test";
import assert from "node:assert/strict";
import { applyFamilyLanguagePolicy } from "../lib/stremio-family-language-policy.mjs";

test("defaults family playback to Latin", () => {
  assert.deepEqual(
    applyFamilyLanguagePolicy({ profile: "family", query: "Minions" }),
    { profile: "family", query: "Minions", language: "latin" }
  );
});

test("defaults kids playback to Latin", () => {
  assert.equal(applyFamilyLanguagePolicy({ profile: "kids" }).language, "latin");
});

test("preserves an explicit language", () => {
  assert.equal(applyFamilyLanguagePolicy({ profile: "family", language: "spanish" }).language, "spanish");
  assert.equal(applyFamilyLanguagePolicy({ profile: "family", language: "english" }).language, "english");
});

test("does not change normal playback", () => {
  assert.deepEqual(applyFamilyLanguagePolicy({ profile: "default", query: "Heat" }), { profile: "default", query: "Heat" });
});
