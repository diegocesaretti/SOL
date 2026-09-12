import test from "node:test";
import assert from "node:assert/strict";
import { SolPluginClient } from "../lib/sol-client.mjs";

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

test("Stremio status reports automatic visual selection readiness", () => {
  const client = new SolPluginClient({
    HA_SOL_TV_ENABLED: "true",
    HA_SOL_TV_URL: "http://192.168.1.80:8765",
    HA_SOL_STREMIO_AUTOSELECT_STREAM: "true"
  });
  const status = client.stremioStatus();
  assert.equal(status.visualAutoSelect.enabled, true);
  assert.equal(status.visualAutoSelect.configured, true);
});
