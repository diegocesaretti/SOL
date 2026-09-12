import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeWatchedField,
  normalizeLibraryItem,
  resolveNextEpisodeFromLibrary
} from "../lib/stremio-account.mjs";

function seriesMeta(count = 9) {
  return {
    id: "tt2934286",
    name: "Example Series",
    videos: Array.from({ length: count }, (_, index) => ({
      id: `tt2934286:1:${index + 1}`,
      season: 1,
      episode: index + 1,
      title: `Episode ${index + 1}`,
      released: "2020-01-01T00:00:00.000Z"
    }))
  };
}

// Official stremio-watched-bitfield sample: first five episode bits are true.
const WATCHED_FIRST_FIVE = "tt2934286:1:5:5:eJyTZwAAAEAAIA==";

test("decodes Stremio watched bitfield with episode ids containing colons", () => {
  const ids = seriesMeta().videos.map((video) => video.id);
  const flags = decodeWatchedField(WATCHED_FIRST_FIVE, ids);
  assert.deepEqual(flags.slice(0, 6), [true, true, true, true, true, false]);
});

test("uses watched bitfield when video_id is stale and selects episode 6", () => {
  const item = normalizeLibraryItem({
    _id: "series:tt2934286",
    type: "series",
    name: "Example Series",
    removed: false,
    state: {
      video_id: "tt2934286:1:2",
      season: 1,
      episode: 2,
      timeOffset: 0,
      duration: 3600000,
      watched: WATCHED_FIRST_FIVE,
      lastWatched: "2026-01-01T00:00:00.000Z"
    }
  });
  const decision = resolveNextEpisodeFromLibrary(seriesMeta(), item);
  assert.equal(decision.status, "next_unwatched");
  assert.equal(decision.episode.id, "tt2934286:1:6");
  assert.equal(decision.history.watchedBitfieldUsed, true);
});

test("resumes an in-progress current episode before advancing", () => {
  const item = normalizeLibraryItem({
    _id: "series:tt2934286",
    type: "series",
    name: "Example Series",
    removed: false,
    state: {
      video_id: "tt2934286:1:6",
      season: 1,
      episode: 6,
      timeOffset: 1800000,
      duration: 3600000,
      watched: WATCHED_FIRST_FIVE,
      lastWatched: "2026-01-01T00:00:00.000Z"
    }
  });
  const decision = resolveNextEpisodeFromLibrary(seriesMeta(), item);
  assert.equal(decision.status, "resume_in_progress");
  assert.equal(decision.episode.id, "tt2934286:1:6");
  assert.equal(decision.history.progressPercent, 50);
});

test("starts at first regular episode without account history and ignores specials", () => {
  const meta = seriesMeta(2);
  meta.videos.unshift({
    id: "tt2934286:0:1",
    season: 0,
    episode: 1,
    title: "Special",
    released: "2019-01-01T00:00:00.000Z"
  });
  const decision = resolveNextEpisodeFromLibrary(meta, null);
  assert.equal(decision.status, "first_episode");
  assert.equal(decision.episode.id, "tt2934286:1:1");
});

test("does not choose unreleased future episodes", () => {
  const meta = seriesMeta(2);
  meta.videos[1].released = "2999-01-01T00:00:00.000Z";
  const item = normalizeLibraryItem({
    _id: "series:tt2934286",
    type: "series",
    removed: false,
    state: {
      video_id: "tt2934286:1:1",
      timeOffset: 3600000,
      duration: 3600000,
      watched: "tt2934286:1:1:1:eJyTZwAAAEAAIA=="
    }
  });
  const decision = resolveNextEpisodeFromLibrary(meta, item, { now: Date.parse("2026-09-12T00:00:00Z") });
  assert.equal(decision.status, "caught_up");
  assert.equal(decision.episode, null);
});
