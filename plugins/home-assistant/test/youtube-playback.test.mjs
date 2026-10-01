import assert from "node:assert/strict";
import test from "node:test";
import {
  buildYoutubePlayPlan,
  normalizeYoutubeUrl,
  resolveYoutubeTarget,
  verifyYoutubePlayback,
  youtubeTargetsFromEnv
} from "../lib/youtube-playback.mjs";

test("YouTube targets use the exact configured media_player entities", () => {
  const targets = youtubeTargetsFromEnv({
    HA_SOL_YOUTUBE_COCINA_ENTITY_ID: "media_player.kitchen_exact",
    HA_SOL_YOUTUBE_DORMITORIO_ENTITY_ID: "media_player.bedroom_exact"
  });
  assert.equal(resolveYoutubeTarget({}, targets).entityId, "media_player.kitchen_exact");
  assert.equal(resolveYoutubeTarget({ target: "dormitorio" }, targets).entityId, "media_player.bedroom_exact");
});

test("YouTube URLs accept a video id and reject non-YouTube hosts", () => {
  assert.equal(normalizeYoutubeUrl("dQw4w9WgXcQ"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.match(normalizeYoutubeUrl("https://youtu.be/dQw4w9WgXcQ"), /^https:\/\/youtu\.be\//);
  assert.throws(() => normalizeYoutubeUrl("https://example.com/video"), /youtube_url_invalid_host/);
});

test("YouTube plan always maps to the configured target", () => {
  const targets = {
    cocina: { target: "cocina", entityId: "media_player.tv_cocina_2" },
    dormitorio: { target: "dormitorio", entityId: "media_player.tv_dormitorio_2" }
  };
  const plan = buildYoutubePlayPlan({
    url: "dQw4w9WgXcQ",
    target: "cocina",
    expectedTitle: "Never Gonna Give You Up"
  }, targets);

  assert.equal(plan.destination.entityId, "media_player.tv_cocina_2");
  assert.equal(plan.serviceData.media.media_content_type, "url");
  assert.equal(plan.serviceData.media.media_content_id, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
});

test("verification confirms a changed YouTube state", async () => {
  const plan = {
    destination: { target: "cocina", entityId: "media_player.tv_cocina_2" },
    expectedTitle: "Radiohead Creep"
  };
  const beforeState = {
    entityId: "media_player.tv_cocina_2",
    state: "on",
    lastUpdated: "before",
    attributes: { app_id: "com.google.android.youtube.tv" }
  };

  const afterState = {
    entityId: "media_player.tv_cocina_2",
    state: "playing",
    lastUpdated: "after",
    attributes: {
      app_id: "com.google.android.youtube.tv",
      media_title: "Radiohead - Creep"
    }
  };

  const result = await verifyYoutubePlayback({
    plan,
    beforeState,
    timeoutMs: 500,
    readState: async () => afterState
  });

  assert.equal(result.confirmed, true);
  assert.equal(result.level, "expected_title");
  assert.equal(result.state.entityId, "media_player.tv_cocina_2");
});
