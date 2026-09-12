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
      HA_SOL_STREMIO_FIRST_STREAM_DELAY_MS: "250"
    });
    const result = await client.clickFirstStream();
    assert.equal(result.ok, true);
    assert.equal(result.command, "DPAD_CENTER");
    assert.equal(request.url, "http://homeassistant.local:8123/api/services/remote/send_command");
    assert.deepEqual(request.body, {
      entity_id: "remote.android_tv",
      command: "DPAD_CENTER"
    });
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
  assert.equal(status.visualAutoSelect.enabled, true);
  assert.equal(status.visualAutoSelect.configured, true);
  assert.equal(status.visualAutoSelect.role, "fallback_only");
});
