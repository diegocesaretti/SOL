import test from "node:test";
import assert from "node:assert/strict";
import {
  buildYoutubePlayPlan,
  normalizeYoutubeUrl,
  resolveYoutubeTarget,
  titlesLikelyMatch,
  youtubeStateEvidence
} from "./sol-fast-youtube.mjs";

test("YouTube target defaults to cocina", () => {
  assert.equal(resolveYoutubeTarget().target, "cocina");
  assert.equal(resolveYoutubeTarget().entityId, "media_player.tv_cocina_2");
});

test("YouTube target resolves dormitorio", () => {
  const result = resolveYoutubeTarget({ target: "dormitorio" });
  assert.equal(result.target, "dormitorio");
  assert.equal(result.entityId, "media_player.tv_dormitorio_2");
  assert.deepEqual(result.verifyEntityIds, [
    "media_player.tv_dormitorio_2",
    "media_player.tv_dormitorio"
  ]);
});

test("YouTube target rejects unknown rooms", () => {
  assert.throws(() => resolveYoutubeTarget({ target: "living" }), /youtube_target_invalid/);
});

test("YouTube URL accepts youtube.com and youtu.be only", () => {
  assert.match(normalizeYoutubeUrl("https://youtu.be/dQw4w9WgXcQ"), /^https:\/\/youtu\.be\//);
  assert.match(normalizeYoutubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), /^https:\/\/www\.youtube\.com\//);
  assert.throws(() => normalizeYoutubeUrl("https://example.com/video"), /youtube_url_invalid_host/);
});

test("play plan maps dormitorio to Home Assistant play_media", () => {
  const plan = buildYoutubePlayPlan({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    target: "dormitorio",
    expectedTitle: "Never Gonna Give You Up"
  });
  assert.equal(plan.destination.entityId, "media_player.tv_dormitorio_2");
  assert.equal(plan.tool, "home_assistant_call_service");
  assert.equal(plan.toolArgs.domain, "media_player");
  assert.equal(plan.toolArgs.service, "play_media");
  assert.equal(plan.toolArgs.target.entity_id, "media_player.tv_dormitorio_2");
  assert.equal(plan.toolArgs.serviceData.media.media_content_type, "url");
  assert.equal(plan.toolArgs.confirmedByUser, true);
});

test("title matcher tolerates artist/title variations", () => {
  assert.equal(
    titlesLikelyMatch("Creedence Have You Ever Seen The Rain", "Have You Ever Seen The Rain"),
    true
  );
  assert.equal(titlesLikelyMatch("Radiohead Creep", "Karma Police"), false);
});

test("state evidence recognizes YouTube app and expected title", () => {
  const state = {
    entityId: "media_player.tv_dormitorio",
    state: "playing",
    lastUpdated: "2026-10-01T00:00:00Z",
    attributes: {
      app_name: "YouTube",
      media_title: "Have You Ever Seen The Rain"
    }
  };
  const evidence = youtubeStateEvidence(state, "Creedence Have You Ever Seen The Rain");
  assert.equal(evidence.level, "expected_title");
  assert.equal(evidence.appActive, true);
});
