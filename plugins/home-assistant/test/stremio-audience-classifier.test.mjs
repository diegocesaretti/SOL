import test from "node:test";
import assert from "node:assert/strict";
import { classifyAudience, installStremioAudienceClassifier } from "../lib/stremio-audience-classifier.mjs";

const options = {
  familyEnabled: true,
  familyTitles: [],
  familyGenres: ["family", "kids", "children"],
  kidsTitles: [],
  kidsGenres: ["kids", "children"],
  heuristicEnabled: true
};

test("Kids/Children genre classifies as kids before generic family", () => {
  assert.equal(classifyAudience({ name: "Bluey", genres: ["Kids", "Animation"] }, options).profile, "kids");
});

test("Family plus Animation is treated as kids", () => {
  const result = classifyAudience({ name: "Toy Story", genres: ["Animation", "Adventure", "Family"] }, options);
  assert.equal(result.profile, "kids");
  assert.equal(result.source, "family_animation");
});

test("live-action Family metadata remains family", () => {
  const result = classifyAudience({ name: "Paddington", genres: ["Adventure", "Family"] }, options);
  assert.equal(result.profile, "family");
});

test("G and TV-Y ratings route to kids", () => {
  assert.equal(classifyAudience({ name: "Movie", certification: "G" }, options).profile, "kids");
  assert.equal(classifyAudience({ name: "Show", contentRating: "TV-Y7" }, options).profile, "kids");
});

test("PG and ATP ratings route to family", () => {
  assert.equal(classifyAudience({ name: "Movie", certification: "PG" }, options).profile, "family");
  assert.equal(classifyAudience({ name: "Movie", ageRating: "ATP" }, options).profile, "family");
});

test("conservative animation heuristic catches child-oriented combinations", () => {
  const result = classifyAudience({ name: "Animated Adventure", genres: ["Animation", "Adventure", "Fantasy", "Comedy"] }, options);
  assert.equal(result.profile, "kids");
  assert.equal(result.source, "animation_genre_heuristic");
});

test("animation plus comedy alone does not imply kids", () => {
  const result = classifyAudience({ name: "Adult Animation", genres: ["Animation", "Comedy"] }, options);
  assert.equal(result.profile, "default");
});

test("adult-coded genres block the animation heuristic", () => {
  const result = classifyAudience({ name: "Animated Horror", genres: ["Animation", "Adventure", "Fantasy", "Horror"] }, options);
  assert.equal(result.profile, "default");
});

test("semantic cache wins over ambiguous metadata", () => {
  const result = classifyAudience({ name: "Ambiguous", genres: ["Adventure"] }, { ...options, cachedProfile: "kids" });
  assert.equal(result.profile, "kids");
  assert.equal(result.source, "semantic_cache");
});

test("explicit kids is translated to isolated family playback provider", async () => {
  class FakeClient {
    constructor() {
      this.env = { HA_SOL_STREMIO_FAMILY_ENABLED: "true" };
      this.cinemeta = {
        resolve: async () => ({ id: "tt123", type: "movie", selected: { id: "tt123", type: "movie", name: "Paw Patrol" } }),
        meta: async () => ({ id: "tt123", type: "movie", name: "Paw Patrol", genres: ["Animation"] })
      };
    }
    async handleStremioTool(tool, args) {
      return { tool, receivedProfile: args.profile, smartPlayback: { effectiveProfile: args.profile } };
    }
  }

  const tools = [{
    name: "home_assistant_stremio_play_best",
    inputSchema: { properties: { profile: { type: "string", enum: ["auto", "default", "family", "sports"] } } }
  }];
  installStremioAudienceClassifier(FakeClient, tools);
  const client = new FakeClient();
  const result = await client.handleStremioTool("home_assistant_stremio_play_best", { query: "Paw Patrol", profile: "kids" });

  assert.equal(result.receivedProfile, "family");
  assert.equal(result.audienceProfile, "kids");
  assert.equal(result.audienceClassification.playbackProfile, "family");
  assert.ok(tools[0].inputSchema.properties.profile.enum.includes("kids"));
});
