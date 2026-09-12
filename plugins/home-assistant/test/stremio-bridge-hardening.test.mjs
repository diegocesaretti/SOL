import test from "node:test";
import assert from "node:assert/strict";
import { SolPluginClient } from "../lib/sol-client.mjs";
import { installStremioAddonCompatibilityPatch, __test } from "../lib/stremio-addon-compat.mjs";

test("configured D-profile path is preserved without exposing it in diagnostics", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ streams: [{ infoHash: "a".repeat(40), fileIdx: 1, name: "1080p" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const aggregator = {
      timeoutMs: 20000,
      addons: [{
        id: "mediafusion",
        name: "MediaFusion",
        version: "6.1.6",
        manifestUrl: "https://addon.example/D-secret-profile/manifest.json",
        manifest: { resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }] }
      }],
      async refresh() { return this.addons; },
      async status() { return { addons: [{ id: "mediafusion", name: "MediaFusion", version: "6.1.6" }] }; },
      async rankStreams(mediaType, mediaId, preferences = {}) {
        const result = await this.getStreams(mediaType, mediaId, { provider: preferences.provider });
        return { ranked: result.streams.map((entry) => ({ ...entry, score: 0, reasons: [], details: { sizeGb: null, seeders: null } })), errors: result.errors, providers: result.providers };
      },
      async selectStream(mediaType, mediaId, preferences = {}) {
        const result = await this.rankStreams(mediaType, mediaId, preferences);
        return { ...result, selected: result.ranked[0] || null };
      }
    };
    installStremioAddonCompatibilityPatch(aggregator, { retries: 0 });
    const result = await aggregator.getStreams("movie", "tt0121766");
    assert.equal(result.streams.length, 1);
    assert.equal(calls[0], "https://addon.example/D-secret-profile/stream/movie/tt0121766.json");
    assert.equal(result.providers[0].profileMode, "anonymous_config");
    assert.equal(JSON.stringify(result.providers).includes("D-secret-profile"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stream Bridge size parser honors behaviorHints.videoSize and GiB", () => {
  assert.ok(Math.abs(__test.streamSizeGb({ behaviorHints: { videoSize: 5 * 1024 ** 3 } }) - 5) < 0.001);
  assert.equal(__test.streamSizeGb({ title: "1080p · 7.5 GiB" }), 7.5);
});

test("transient addon HTTP failure is retried once", async () => {
  const originalFetch = globalThis.fetch;
  let count = 0;
  globalThis.fetch = async () => {
    count += 1;
    if (count === 1) return new Response("busy", { status: 503 });
    return new Response(JSON.stringify({ streams: [{ url: "https://video.example/movie.mp4" }] }), { status: 200 });
  };
  try {
    const addon = {
      id: "retry-addon",
      name: "Retry Addon",
      version: "1",
      manifestUrl: "https://addon.example/manifest.json",
      manifest: { resources: ["stream"], types: ["movie"] }
    };
    const result = await __test.requestProvider(addon, "movie", "tt0121766", 2000, 1);
    assert.equal(result.streams.length, 1);
    assert.equal(result.attempts[0].networkAttempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("play_best continues through native Stremio when direct addon lookup returns zero", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, body: options.body ? JSON.parse(String(options.body)) : null });
    if (href.includes("/api/services/remote/turn_on") || href.includes("/api/services/remote/send_command")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${href}`);
  };
  try {
    const client = new SolPluginClient({
      HA_URL: "http://homeassistant.local:8123",
      HA_TOKEN: "test-token",
      HA_SOL_ALLOW_CONTROL: "true",
      HA_SOL_STREMIO_ENABLED: "true",
      HA_SOL_STREMIO_REMOTE_ENTITY_ID: "remote.android_tv",
      HA_SOL_STREMIO_ADDONS: "https://addon.example/manifest.json",
      HA_SOL_STREMIO_FIRST_STREAM_DELAY_MS: "500",
      HA_SOL_STREMIO_ADDON_TIMEOUT_MS: "20000"
    });
    client.resolveForStream = async () => ({
      resolved: { type: "movie", id: "tt0121766", videoId: "tt0121766", selected: { name: "Star Wars III" } },
      streamId: "tt0121766"
    });
    client.addonAggregator.selectStream = async () => ({
      selected: null,
      ranked: [],
      providers: [{ id: "x", name: "Addon", version: "1", profileMode: "public_or_path_config", streamCount: 0, attempts: [{ variant: "encoded_id", ok: true, status: 200, count: 0 }] }],
      errors: [{ addonName: "Addon", error: "stremio_addon_zero_streams" }]
    });

    const result = await client.handleStremioTool("home_assistant_stremio_play_best", { id: "tt0121766", mediaType: "movie" });
    assert.equal(result.nativeFallback.used, true);
    assert.equal(result.deliveryMode, "first_stream_center_click");
    assert.equal(result.playbackRequested, true);
    const launch = calls.find((entry) => entry.href.endsWith("/api/services/remote/turn_on"));
    const click = calls.find((entry) => entry.href.endsWith("/api/services/remote/send_command"));
    assert.ok(launch.body.activity.includes("tt0121766"));
    assert.ok(launch.body.activity.includes("autoPlay=true"));
    assert.deepEqual(click.body, { entity_id: "remote.android_tv", command: "DPAD_CENTER" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});