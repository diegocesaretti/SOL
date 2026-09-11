import test from "node:test";
import assert from "node:assert/strict";
import {
  CinemetaClient,
  addonDeepLink,
  boardDeepLink,
  detailDeepLink,
  discoverCatalogDeepLink,
  libraryDeepLink,
  searchDeepLink
} from "../lib/stremio.mjs";

test("builds documented Stremio page and search deep links", () => {
  assert.equal(boardDeepLink(), "stremio:///board");
  assert.equal(libraryDeepLink(), "stremio:///library");
  assert.equal(searchDeepLink("The Last of Us"), "stremio:///search?search=The%20Last%20of%20Us");
});

test("builds movie and series detail deep links", () => {
  assert.equal(
    detailDeepLink({ type: "movie", id: "tt0816692", videoId: "tt0816692", autoPlay: true }),
    "stremio:///detail/movie/tt0816692/tt0816692?autoPlay=true"
  );
  assert.equal(
    detailDeepLink({ type: "series", id: "tt0903747", videoId: "tt0903747:2:3", autoPlay: true }),
    "stremio:///detail/series/tt0903747/tt0903747:2:3?autoPlay=true"
  );
});

test("builds catalog and addon deep links", () => {
  const catalog = discoverCatalogDeepLink({
    manifestUrl: "https://v3-cinemeta.strem.io/manifest.json",
    type: "movie",
    catalogId: "top",
    genre: "Sci-Fi"
  });
  assert.match(catalog, /^stremio:\/\/\/discover\//);
  assert.match(catalog, /\/movie\/top\?genre=Sci-Fi$/);
  assert.equal(
    addonDeepLink("https://watchhub-us.strem.io/manifest.json"),
    "stremio://watchhub-us.strem.io/manifest.json"
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
    const result = await client.resolve({ query: "Breaking Bad", mediaType: "series", season: 2, episode: 3, autoPlay: true });
    assert.equal(result.id, "tt0903747");
    assert.equal(result.videoId, "tt0903747:2:3");
    assert.equal(result.deepLink, "stremio:///detail/series/tt0903747/tt0903747:2:3?autoPlay=true");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cinemeta adjacent episode crosses episode order", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const text = String(url);
    if (text.includes("/meta/series/tt1.json")) {
      return new Response(JSON.stringify({ meta: {
        id: "tt1",
        type: "series",
        name: "Test",
        videos: [
          { id: "tt1:1:1", season: 1, episode: 1 },
          { id: "tt1:1:2", season: 1, episode: 2 },
          { id: "tt1:2:1", season: 2, episode: 1 }
        ]
      } }), { status: 200 });
    }
    if (text.includes("/meta/movie/tt1.json")) return new Response(JSON.stringify({}), { status: 404 });
    throw new Error(`unexpected URL ${text}`);
  };
  try {
    const client = new CinemetaClient({ timeoutMs: 2000 });
    const result = await client.adjacentEpisode({ id: "tt1", currentSeason: 1, currentEpisode: 2, direction: "next" });
    assert.equal(result.season, 2);
    assert.equal(result.episode, 1);
    assert.equal(result.deepLink, "stremio:///detail/series/tt1/tt1:2:1?autoPlay=true");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
