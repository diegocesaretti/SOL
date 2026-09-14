import test from "node:test";
import assert from "node:assert/strict";
import { queryProviderStreams, splitConfiguredManifestUrl, streamResourceUrl } from "../lib/stremio-provider-query.mjs";

test("preserves configured manifest path/query while deriving stream resource", () => {
  const configured = splitConfiguredManifestUrl("https://addon.example/custom/manifest.json?token=abc#ignored");
  assert.equal(configured.basePart, "https://addon.example/custom");
  assert.equal(configured.queryPart, "?token=abc");
  assert.equal(
    streamResourceUrl("https://addon.example/custom/manifest.json?token=abc", "series", "tt1:2:3"),
    "https://addon.example/custom/stream/series/tt1%3A2%3A3.json?token=abc"
  );
});

test("uses raw-colon fallback for episode ids and preserves duplicate streams", async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    seen.push(value);
    if (value.includes("tt1%3A2%3A3.json")) {
      return new Response(JSON.stringify({ streams: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (value.includes("tt1:2:3.json")) {
      return new Response(JSON.stringify({ streams: [
        { title: "Same stream", url: "https://video.example/a" },
        { title: "Same stream", url: "https://video.example/a" }
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected URL ${value}`);
  };
  try {
    const result = await queryProviderStreams({
      manifestUrl: "https://addon.example/manifest.json",
      mediaType: "series",
      mediaId: "tt1:2:3",
      timeoutMs: 2000,
      retries: 0
    });
    assert.equal(result.error, null);
    assert.equal(result.streams.length, 2);
    assert.equal(result.streams[0].url, result.streams[1].url);
    assert.equal(seen.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("valid zero-stream response is known count zero, not an uncertain provider", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ streams: [] }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const result = await queryProviderStreams({
      manifestUrl: "https://addon.example/manifest.json",
      mediaType: "movie",
      mediaId: "tt0133093",
      timeoutMs: 2000,
      retries: 0
    });
    assert.equal(result.error, null);
    assert.deepEqual(result.streams, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
