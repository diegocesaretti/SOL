import test from "node:test";
import assert from "node:assert/strict";
import { SolPluginClient } from "../lib/sol-client.mjs";

test("Stremio first-stream autoplay sends one DPAD_CENTER through Home Assistant", async () => {
  const originalFetch = globalThis.fetch;
  let request = null;
  globalThis.fetch = async (url, options = {}) => {
    request = { url: String(url), body: JSON.parse(String(options.body || "{}")) };
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const client = new SolPluginClient({
      HA_URL: "http://homeassistant.local:8123",
      HA_TOKEN: "test-token",
      HA_SOL_STREMIO_REMOTE_ENTITY_ID: "remote.android_tv",
      HA_SOL_STREMIO_AUTOPLAY_FIRST_STREAM: "true",
      HA_SOL_STREMIO_FIRST_STREAM_DELAY_MS: "500"
    });
    const result = await client.clickFirstStream();
    assert.equal(result.ok, true);
    assert.equal(result.command, "DPAD_CENTER");
    assert.equal(result.readiness.via, "fixed_delay");
    assert.equal(request.url, "http://homeassistant.local:8123/api/services/remote/send_command");
    assert.deepEqual(request.body, {
      entity_id: "remote.android_tv",
      command: "DPAD_CENTER"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stremio waits for a visible stream row before sending DPAD_CENTER when Satellite is available", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    requests.push({ url: href, method: options.method || "GET", body: options.body ? JSON.parse(String(options.body)) : null });
    if (href.startsWith("http://192.168.1.80:8765/observe")) {
      return new Response(JSON.stringify({
        package: "com.stremio.one",
        ui_event_sequence: 42,
        focus_hint: { text: "1080p WEB-DL · 5.4 GB" },
        tree: { text: "1080p WEB-DL · 5.4 GB", children: [] }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href === "http://homeassistant.local:8123/api/services/remote/send_command") {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };

  try {
    const client = new SolPluginClient({
      HA_URL: "http://homeassistant.local:8123",
      HA_TOKEN: "test-token",
      HA_SOL_STREMIO_REMOTE_ENTITY_ID: "remote.android_tv",
      HA_SOL_STREMIO_AUTOPLAY_FIRST_STREAM: "true",
      HA_SOL_STREMIO_FIRST_STREAM_DELAY_MS: "500",
      HA_SOL_TV_ENABLED: "true",
      HA_SOL_TV_URL: "http://192.168.1.80:8765",
      HA_SOL_TV_TIMEOUT_MS: "2000"
    });
    const result = await client.clickFirstStream();
    assert.equal(result.ok, true);
    assert.equal(result.readiness.via, "tv_satellite");
    assert.equal(result.readiness.state.streamLike, true);
    assert.equal(requests.some((entry) => entry.url.startsWith("http://192.168.1.80:8765/observe")), true);
    const commandRequest = requests.find((entry) => entry.url.endsWith("/api/services/remote/send_command"));
    assert.deepEqual(commandRequest.body, { entity_id: "remote.android_tv", command: "DPAD_CENTER" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stremio does not send DPAD_CENTER when Satellite already exposes player controls", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    requests.push(href);
    if (href.startsWith("http://192.168.1.80:8765/observe")) {
      return new Response(JSON.stringify({
        package: "com.stremio.one",
        tree: { text: "Pause Subtitles Audio track", children: [] }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };

  try {
    const client = new SolPluginClient({
      HA_URL: "http://homeassistant.local:8123",
      HA_TOKEN: "test-token",
      HA_SOL_STREMIO_REMOTE_ENTITY_ID: "remote.android_tv",
      HA_SOL_STREMIO_AUTOPLAY_FIRST_STREAM: "true",
      HA_SOL_STREMIO_FIRST_STREAM_DELAY_MS: "500",
      HA_SOL_TV_ENABLED: "true",
      HA_SOL_TV_URL: "http://192.168.1.80:8765"
    });
    const result = await client.clickFirstStream();
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "stremio_player_already_visible");
    assert.equal(requests.some((href) => href.includes("/api/services/remote/send_command")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stremio visual auto-select clicks the chosen stream through TV Satellite execute", async () => {
  const originalFetch = globalThis.fetch;
  let request = null;
  globalThis.fetch = async (url, options = {}) => {
    request = { url: String(url), body: JSON.parse(String(options.body || "{}")) };
    return new Response(JSON.stringify({ ok: true, actions: [{ ok: true, action: "click_text" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const client = new SolPluginClient({
      HA_SOL_TV_ENABLED: "true",
      HA_SOL_TV_URL: "http://192.168.1.80:8765",
      HA_SOL_TV_TIMEOUT_MS: "2000",
      HA_SOL_STREMIO_AUTOSELECT_STREAM: "true"
    });
    const result = await client.tvClickText("1080p Latino");
    assert.equal(result.ok, true);
    assert.equal(result.via, "execute");
    assert.equal(request.url, "http://192.168.1.80:8765/execute");
    assert.deepEqual(request.body.actions, [{ action: "click_text", text: "1080p Latino" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stremio status reports first-stream and visual fallback readiness", () => {
  const client = new SolPluginClient({
    HA_SOL_STREMIO_REMOTE_ENTITY_ID: "remote.android_tv",
    HA_SOL_STREMIO_AUTOPLAY_FIRST_STREAM: "true",
    HA_SOL_TV_ENABLED: "true",
    HA_SOL_TV_URL: "http://192.168.1.80:8765",
    HA_SOL_STREMIO_AUTOSELECT_STREAM: "true"
  });
  const status = client.stremioStatus();
  assert.equal(status.firstStreamAutoPlay.enabled, true);
  assert.equal(status.firstStreamAutoPlay.configured, true);
  assert.equal(status.firstStreamAutoPlay.readiness.includes("Satellite"), true);
  assert.equal(status.visualAutoSelect.enabled, true);
  assert.equal(status.visualAutoSelect.configured, true);
  assert.equal(status.visualAutoSelect.role, "fallback_only");
});
