import test from "node:test";
import assert from "node:assert/strict";
import { classifyPlaybackProfile, __test } from "../lib/stremio-smart-playback.mjs";

test("auto profile routes Cinemeta Family genre to isolated family provider", () => {
  const profile = classifyPlaybackProfile({
    selected: { name: "Paddington", genres: ["Adventure", "Family"] }
  }, {
    requestedProfile: "auto",
    familyEnabled: true,
    familyTitles: [],
    familyGenres: ["family", "kids", "children"]
  });
  assert.equal(profile, "family");
});

test("animation alone does not automatically imply family", () => {
  const profile = classifyPlaybackProfile({
    selected: { name: "Adult Animation", genres: ["Animation", "Comedy"] }
  }, {
    requestedProfile: "auto",
    familyEnabled: true,
    familyTitles: [],
    familyGenres: ["family", "kids", "children"]
  });
  assert.equal(profile, "default");
});

test("forced normalized title routes to family even without Family genre", () => {
  const profile = classifyPlaybackProfile({
    selected: { name: "Paw Patrol: The Movie", genres: ["Animation"] }
  }, {
    requestedProfile: "auto",
    familyEnabled: true,
    familyTitles: [__test.normalizeText("Paw Patrol: The Movie")],
    familyGenres: ["family", "kids", "children"]
  });
  assert.equal(profile, "family");
});

test("explicit default overrides automatic family routing", () => {
  const profile = classifyPlaybackProfile({
    selected: { name: "Paddington", genres: ["Family"] }
  }, {
    requestedProfile: "default",
    familyEnabled: true,
    familyTitles: [],
    familyGenres: ["family"]
  });
  assert.equal(profile, "default");
});

test("family Spanish filter removes unlabeled and English-only streams", () => {
  const spanish = { details: { languages: ["spanish"] }, stream: { title: "1080p Español" } };
  const latin = { details: { languages: ["latin"] }, stream: { title: "1080p Latino" } };
  const english = { details: { languages: ["english"] }, stream: { title: "1080p English" } };
  const unknown = { details: { languages: [] }, stream: { title: "1080p" } };
  const filtered = __test.familySpanishSelection({
    selected: english,
    ranked: [english, unknown, spanish, latin],
    errors: [],
    providers: []
  });
  assert.equal(filtered.ranked.length, 2);
  assert.equal(filtered.selected, spanish);
  assert.deepEqual(filtered.ranked, [spanish, latin]);
  assert.equal(filtered.familyLanguageFilter, "spanish_or_latin_hard_filter");
});
