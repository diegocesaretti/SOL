import test from "node:test";
import assert from "node:assert/strict";
import { installStremioAddonCompatibilityPatch, __test } from "../lib/stremio-addon-compat.mjs";

function completeAggregator(aggregator) {
  return {
    ...aggregator,
    async status() { return { addons: this.addons.map((addon) => ({ id: addon.id, name: addon.name, version: addon.version || "1" })) }; },
    async rankStreams() { return { ranked: [], errors: [], providers: [] }; }
  };
}

test("resource URL preserves manifest query and percent-encodes series episode colons", () => {
  const url = __test.resourceUrl(
    "https://addon.example/config/manifest.json?token=secret",
    "series",
    "tt0903747:2:3"
  );
  assert.equal(url, "https://addon.example/config/stream/series/tt0903747%3A2%3A3.json?token=secret");
});

test("compat layer queries configured stream addon even when manifest prefix filter disagrees", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ streams: [
      { url: "https://video.example/movie.mp4", name: "1080p" }
    ] }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const aggregator = completeAggregator({
      timeoutMs: 2000,
      addons: [{
        id: "odd-addon",
        name: "Odd Addon",
        version: "1",
        manifestUrl: "https://addon.example/manifest.json",
        manifest: {
          resources: [{ name: "stream", types: ["movie"], idPrefixes: ["kitsu:"] }],
          types: ["movie"]
        }
      }],
      async refresh() { return this.addons; }
    });
    installStremioAddonCompatibilityPatch(aggregator, { retries: 0 });
    const result = await aggregator.getStreams("movie", "tt0120915");
    assert.equal(result.streams.length, 1);
    assert.equal(result.providers.length, 1);
    assert.equal(result.providers[0].manifestCompatible, false);
    assert.equal(calls[0], "https://addon.example/stream/movie/tt0120915.json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("compat layer falls back from encoded episode id to raw colons when needed", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.includes("tt0903747%3A2%3A3.json")) {
      return new Response(JSON.stringify({ streams: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (value.includes("tt0903747:2:3.json")) {
      return new Response(JSON.stringify({ streams: [
        { infoHash: "a".repeat(40), fileIdx: 0, name: "1080p" }
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected URL ${value}`);
  };

  try {
    const aggregator = completeAggregator({
      timeoutMs: 2000,
      addons: [{
        id: "series-addon",
        name: "Series Addon",
        version: "1",
        manifestUrl: "https://addon.example/config/manifest.json",
        manifest: {
          resources: [{ name: "stream", types: ["series"], idPrefixes: ["tt"] }],
          types: ["series"]
        }
      }],
      async refresh() { return this.addons; }
    });
    installStremioAddonCompatibilityPatch(aggregator, { retries: 0 });
    const result = await aggregator.getStreams("series", "tt0903747:2:3");
    assert.equal(result.streams.length, 1);
    assert.equal(calls.length, 2);
    assert.equal(result.providers[0].attempts[0].variant, "configured_url_encoded_id");
    assert.equal(result.providers[0].attempts[1].variant, "configured_url_raw_colons_fallback");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("zero stream responses now return provider diagnostics instead of silent zero", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ streams: [] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });

  try {
    const aggregator = completeAggregator({
      timeoutMs: 2000,
      addons: [{
        id: "empty-addon",
        name: "Empty Addon",
        version: "1",
        manifestUrl: "https://addon.example/manifest.json",
        manifest: { resources: ["stream"], types: ["movie", "series"] }
      }],
      async refresh() { return this.addons; }
    });
    installStremioAddonCompatibilityPatch(aggregator, { retries: 0 });
    const result = await aggregator.getStreams("movie", "tt0120915");
    assert.equal(result.streams.length, 0);
    assert.equal(result.errors[0].error, "stremio_addon_zero_streams");
    assert.equal(result.providers[0].streamCount, 0);
    assert.equal(result.providers[0].attempts[0].count, 0);
    assert.equal(result.providers[0].attempts[0].status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});