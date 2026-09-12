import test from "node:test";
import assert from "node:assert/strict";
import { StremioSelectorProxy } from "../lib/stremio-proxy.mjs";

test("selector proxy rewrites Cinemeta ids and returns exactly one selected stream", async () => {
  const aggregator = {
    async selectStream(type, id, preferences) {
      assert.equal(type, "series");
      assert.equal(id, "tt0903747:2:3");
      assert.equal(preferences.language, "latin");
      return {
        selected: {
          addon: { id: "provider.one", name: "Provider One" },
          providerIndex: 0,
          stream: {
            infoHash: "c".repeat(40),
            fileIdx: 4,
            name: "1080p Latino",
            title: "1080p H264 Audio Latino",
            behaviorHints: { filename: "episode.mkv" }
          },
          details: { quality: 1080, languages: ["latin"], codec: "h264", sizeGb: 2.5, seeders: 30, hdr: false, dolbyVision: false, cachedHint: false, locator: "torrent" },
          score: 1000,
          reasons: ["quality_exact", "language_match"]
        }
      };
    }
  };
  const cinemeta = {
    async meta(type, id) {
      assert.equal(type, "series");
      assert.equal(id, "tt0903747");
      return {
        id,
        type,
        name: "Breaking Bad",
        videos: [
          { id: "tt0903747:2:3", season: 2, episode: 3, title: "Bit by a Dead Bee" },
          { id: "tt0903747:2:4", season: 2, episode: 4, title: "Down" }
        ]
      };
    }
  };

  const proxy = new StremioSelectorProxy({
    aggregator,
    cinemeta,
    enabled: true,
    publicUrl: "https://selector.example.com",
    token: "abcdefghijklmnop",
    port: 18770
  });

  const selection = proxy.buildSelectionDeepLink({
    type: "series",
    id: "tt0903747",
    season: 2,
    episode: 3,
    preferences: { quality: "1080p", language: "latin" },
    autoPlay: true
  });

  assert.match(selection.deepLink, /^stremio:\/\/\/detail\/series\/sol:/);
  assert.match(selection.deepLink, /autoPlay=true$/);

  const metaPayload = await proxy.metaResponse("series", selection.metaId);
  assert.equal(metaPayload.meta.id, selection.metaId);
  assert.ok(metaPayload.meta.videos[0].id.startsWith(`sol:${selection.sessionId}:series:tt0903747:`));

  const streamPayload = await proxy.streamResponse("series", selection.videoId);
  assert.equal(streamPayload.streams.length, 1);
  assert.equal(streamPayload.streams[0].infoHash, "c".repeat(40));
  assert.equal(streamPayload.streams[0].fileIdx, 4);
  assert.match(streamPayload.streams[0].name, /^SOL/);
  assert.match(streamPayload.streams[0].behaviorHints.bingeGroup, /^sol-/);
});

test("selector proxy requires trusted HTTPS public origin", () => {
  assert.throws(() => new StremioSelectorProxy({
    aggregator: {},
    cinemeta: {},
    enabled: true,
    publicUrl: "http://192.168.1.10:8770",
    token: "abcdefghijklmnop"
  }), /must_use_https/);
});
