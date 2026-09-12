import test from "node:test";
import assert from "node:assert/strict";
import {
  StremioAddonAggregator,
  parseAddonManifestList,
  summarizeRankedStream
} from "../lib/stremio-addons.mjs";

test("parseAddonManifestList accepts semicolon/newline and JSON array forms", () => {
  assert.deepEqual(parseAddonManifestList("https://a.example/manifest.json;https://b.example/addon"), [
    "https://a.example/manifest.json",
    "https://b.example/addon/manifest.json"
  ]);
  assert.deepEqual(parseAddonManifestList('["https://a.example/manifest.json"]'), ["https://a.example/manifest.json"]);
});

test("addon aggregator queries compatible providers, deduplicates and ranks requested Latino 1080p stream", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value === "https://one.example/manifest.json") {
      return new Response(JSON.stringify({
        id: "one", name: "One", version: "1.0.0",
        resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
        types: ["movie", "series"]
      }), { status: 200 });
    }
    if (value === "https://two.example/manifest.json") {
      return new Response(JSON.stringify({
        id: "two", name: "Two", version: "1.0.0",
        resources: ["stream"], types: ["movie", "series"], idPrefixes: ["tt"]
      }), { status: 200 });
    }
    if (value.includes("one.example/stream/movie/tt0816692.json")) {
      return new Response(JSON.stringify({ streams: [
        { infoHash: "a".repeat(40), fileIdx: 0, name: "4K HEVC English", title: "2160p 18 GB seeders: 55 English" },
        { infoHash: "b".repeat(40), fileIdx: 1, name: "1080p H264 Latino", title: "1080p 5.2 GB 👤 25 Audio Latino" }
      ] }), { status: 200 });
    }
    if (value.includes("two.example/stream/movie/tt0816692.json")) {
      return new Response(JSON.stringify({ streams: [
        { infoHash: "b".repeat(40), fileIdx: 1, name: "duplicate", title: "1080p 5.2 GB Latino" },
        { url: "https://video.example/interstellar.mp4", name: "1080p English", title: "1080p H264 3 GB English" }
      ] }), { status: 200 });
    }
    throw new Error(`unexpected URL ${value}`);
  };

  try {
    const aggregator = new StremioAddonAggregator({
      manifestUrls: ["https://one.example/manifest.json", "https://two.example/manifest.json"],
      timeoutMs: 2000
    });
    const selection = await aggregator.selectStream("movie", "tt0816692", {
      quality: "1080p",
      language: "latin",
      codec: "h264",
      maxSizeGb: 8
    });
    assert.equal(selection.ranked.length, 3);
    const summary = summarizeRankedStream(selection.selected, 0);
    assert.equal(summary.addonName, "One");
    assert.equal(summary.quality, "1080p");
    assert.equal(summary.codec, "h264");
    assert.ok(summary.languages.includes("latin"));
    assert.equal(summary.sizeGb, 5.2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
