import test from "node:test";
import assert from "node:assert/strict";
import { SolPluginClient } from "../lib/sol-client.mjs";

test("playback verification confirms player controls without screenshots", async () => {
  const originalFetch = globalThis.fetch;
  let observeCount = 0;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith("http://192.168.1.80:8765/observe")) {
      observeCount += 1;
      return new Response(JSON.stringify({
        package: "com.stremio.one",
        tree: observeCount < 2
          ? { text: "Buffering", children: [] }
          : { text: "Pause Subtitles Audio track", children: [] }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${href}`);
  };

  try {
    const client = new SolPluginClient({
      HA_SOL_TV_ENABLED: "true",
      HA_SOL_TV_URL: "http://192.168.1.80:8765",
      HA_SOL_TV_TIMEOUT_MS: "2000",
      HA_SOL_STREMIO_PLAYBACK_VERIFY_MS: "2000"
    });
    const result = await client.verifyPlayback();
    assert.equal(result.status, "confirmed");
    assert.equal(result.confirmed, true);
    assert.equal(result.via, "tv_satellite_accessibility");
    assert.equal(result.screenshotRequired, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("black or unavailable screenshot is never treated as playback failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith("http://192.168.1.80:8765/observe")) {
      return new Response(JSON.stringify({
        package: "com.stremio.one",
        tree: { text: "", children: [] }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${href}`);
  };

  try {
    const client = new SolPluginClient({
      HA_SOL_TV_ENABLED: "true",
      HA_SOL_TV_URL: "http://192.168.1.80:8765",
      HA_SOL_STREMIO_PLAYBACK_VERIFY_MS: "500"
    });
    const result = await client.verifyPlayback();
    assert.equal(result.status, "unverified");
    assert.equal(result.confirmed, null);
    assert.equal(result.screenshotRequired, false);
    assert.match(result.note, /not a failure/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requested exact selector falls back to native Stremio when public HTTPS URL is missing", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, body: options.body ? JSON.parse(String(options.body)) : null });
    if (href.endsWith("/api/services/remote/turn_on") || href.endsWith("/api/services/remote/send_command")) {
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
      HA_SOL_STREMIO_PROXY_ENABLED: "true",
      HA_SOL_STREMIO_PROXY_USE_FOR_PLAY: "true",
      HA_SOL_STREMIO_PROXY_TOKEN: "abcdefghijklmnop",
      HA_SOL_STREMIO_FIRST_STREAM_DELAY_MS: "500"
    });
    client.resolveForStream = async () => ({
      resolved: { type: "movie", id: "tt0121766", videoId: "tt0121766", selected: { name: "Star Wars III" } },
      streamId: "tt0121766"
    });
    client.addonAggregator.selectStream = async () => ({
      selected: {
        addon: { id: "addon", name: "Addon" },
        stream: { url: "https://video.example/movie.mp4", name: "1080p" },
        details: { quality: 1080, languages: [], sizeGb: 4, seeders: 20 },
        score: 10,
        reasons: []
      },
      ranked: [],
      providers: [],
      errors: []
    });

    const result = await client.handleStremioTool("home_assistant_stremio_play_best", {
      id: "tt0121766",
      mediaType: "movie"
    });

    assert.equal(result.selectorFallbackReason, "stremio_proxy_public_url_required");
    assert.equal(result.nativeFallback.used, true);
    assert.equal(result.playbackRequested, true);
    assert.equal(result.playbackConfirmed, null);
    const launch = calls.find((entry) => entry.href.endsWith("/api/services/remote/turn_on"));
    assert.ok(launch.body.activity.includes("tt0121766"));
    assert.equal(launch.body.activity.includes("sol:"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});