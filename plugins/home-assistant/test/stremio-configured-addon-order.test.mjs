import test from "node:test";
import assert from "node:assert/strict";
import { installStremioAddonCompatibilityPatch, __test } from "../lib/stremio-addon-compat.mjs";

test("stream resource URL preserves configured path escapes and query byte-for-byte", () => {
  const manifest = "https://addon.example/D-profile%2Fopaque/manifest.json?token=a%2Fb&sort=quality";
  const url = __test.resourceUrl(manifest, "series", "tt0903747:2:3");
  assert.equal(
    url,
    "https://addon.example/D-profile%2Fopaque/stream/series/tt0903747%3A2%3A3.json?token=a%2Fb&sort=quality"
  );
});

test("stream resource URL accepts a configured addon base URL and appends manifest semantics safely", () => {
  const parts = __test.splitConfiguredManifestUrl("https://addon.example/U-user-profile?cfg=abc%2B123#ignored");
  assert.equal(parts.manifestUrl, "https://addon.example/U-user-profile/manifest.json?cfg=abc%2B123");
  assert.equal(parts.basePart, "https://addon.example/U-user-profile");
  assert.equal(parts.queryPart, "?cfg=abc%2B123");
});

test("provider request uses exact configured stream URL and keeps response order", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({
      streams: [
        { url: "https://video.example/preferred.mkv", title: "Preferred first" },
        { url: "https://video.example/second.mkv", title: "Second" }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const addon = {
      id: "configured-addon",
      name: "Configured Addon",
      version: "1",
      manifestUrl: "https://addon.example/D-opaque%2Fconfig/manifest.json?token=x%2Fy",
      manifest: {
        resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }],
        types: ["movie"]
      }
    };
    const result = await __test.requestProvider(addon, "movie", "tt0121766", 2000, 0);
    assert.equal(calls[0], "https://addon.example/D-opaque%2Fconfig/stream/movie/tt0121766.json?token=x%2Fy");
    assert.equal(result.streams.length, 2);
    assert.equal(result.streams[0].title, "Preferred first");
    assert.equal(result.streams[1].title, "Second");
    assert.equal(JSON.stringify(result.attempts).includes("D-opaque"), false);
    assert.equal(JSON.stringify(result.attempts).includes("token=x"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function mockAggregator() {
  const addon = { id: "a", name: "A", version: "1", manifestUrl: "https://a.example/manifest.json", manifest: { resources: ["stream"] } };
  return {
    timeoutMs: 2000,
    addons: [addon],
    async refresh() { return this.addons; },
    async status() { return { addons: [{ id: "a", name: "A", version: "1" }] }; },
    async rankStreams() {
      return {
        ranked: [
          { addon, providerIndex: 1, stream: { title: "Provider second" }, score: 999, reasons: [], details: { sizeGb: null, seeders: 100 } },
          { addon, providerIndex: 0, stream: { title: "Provider first" }, score: 1, reasons: [], details: { sizeGb: null, seeders: 1 } }
        ],
        errors: [],
        providers: [{ id: "a", name: "A" }]
      };
    }
  };
}

test("configured addon order wins over SOL score by default", async () => {
  const aggregator = mockAggregator();
  installStremioAddonCompatibilityPatch(aggregator, { retries: 0, preserveAddonOrder: true });
  const result = await aggregator.rankStreams("movie", "tt0121766", {});
  assert.equal(result.ranked[0].stream.title, "Provider first");
  assert.equal(result.ranked[1].stream.title, "Provider second");
});

test("SOL score ordering remains available when provider ordering is disabled", async () => {
  const aggregator = mockAggregator();
  installStremioAddonCompatibilityPatch(aggregator, { retries: 0, preserveAddonOrder: false });
  const result = await aggregator.rankStreams("movie", "tt0121766", {});
  assert.equal(result.ranked[0].stream.title, "Provider second");
  assert.equal(result.ranked[1].stream.title, "Provider first");
});