import test from "node:test";
import assert from "node:assert/strict";
import {
  CinemetaClient,
  boardDeepLink,
  detailDeepLink,
  discoverDeepLink,
  libraryDeepLink,
  searchDeepLink
} from "../lib/stremio.mjs";

test("builds only the Stremio deep links kept by the single-path architecture", () => {
  assert.equal(boardDeepLink(), "stremio:///board");
  assert.equal(discoverDeepLink(), "stremio:///discover");
  assert.equal(libraryDeepLink(), "stremio:///library");
  assert.equal(searchDeepLink("The Last of Us"), "stremio:///search?search=The%20Last%20of%20Us");
  assert.equal(
    detailDeepLink({ type: "series", id: "tt0903747", videoId: "tt0903747:2:3", autoPlay: false }),
    "stremio:///detail/series/tt0903747/tt0903747:2:3"
  );
});

test("Cinemeta resolves exact series episode and preserves returned video id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const text = String(url);
    if (text.includes("/catalog/series/top/search=Breaking%20Bad.json")) {
      return new Response(JSON.stringify({ metas: [{ id: "tt0903747", type: "series", name: "Breaking Bad", releaseInfo: "2008-2013" }] }), { status: 200 });
    }
    if (text.includes("/meta/series/tt0903747.json")) {
      return new Response(JSON.stringify({ meta: {
        id: "tt0903747",
        type: "series",
        name: "Breaking Bad",
        releaseInfo: "2008-2013",
        videos: [
          { id: "tt0903747:2:2", season: 2, episode: 2, title: "Grilled" },
          { id: "tt0903747:2:3", season: 2, episode: 3, title: "Bit by a Dead Bee" }
        ]
      } }), { status: 200 });
    }
    throw new Error(`unexpected URL ${text}`);
  };
  try {
    const client = new CinemetaClient({ timeoutMs: 2000 });
    const result = await client.resolve({ query: "Breaking Bad", mediaType: "series", season: 2, episode: 3, autoPlay: false });
    assert.equal(result.id, "tt0903747");
    assert.equal(result.videoId, "tt0903747:2:3");
    assert.equal(result.deepLink, "stremio:///detail/series/tt0903747/tt0903747:2:3");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
