import test from "node:test";
import assert from "node:assert/strict";
import { installStremioStableClick } from "../lib/stremio-stable-click.mjs";

function streamObservation() {
  return {
    package: "com.stremio.one",
    tree: { text: "1080p WEB-DL 3.2 GB", children: [] },
    ui_event_sequence: 10
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("uses TV Satellite dpad_center after stable stream-list confirmation", async () => {
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls += 1;
    assert.match(String(url), /\/execute$/);
    const body = JSON.parse(String(options.body || "{}"));
    assert.equal(body.actions?.[0]?.action, "dpad_center");
    return jsonResponse({ ok: true, actions: [{ ok: true, action: "dpad_center" }] });
  };

  try {
    class FakeClient {
      constructor() {
        this.env = {
          HA_SOL_STREMIO_CENTER_DELAY_MS: "0",
          HA_SOL_STREMIO_STREAM_READY_TIMEOUT_MS: "1000",
          HA_SOL_STREMIO_CENTER_TRANSPORT: "auto"
        };
        this.stremioTvEnabled = true;
        this.stremioTvUrl = "http://tv.local:8765";
        this.stremioTvTimeoutMs = 1000;
        this.stremioFirstStreamDelayMs = 500;
        this.stremioAutoPlayFirstStream = true;
        this.stremioRemoteEntityId = "remote.tv";
        this.observeCalls = 0;
        this.haCalls = 0;
      }
      stremioStatus() { return { firstStreamAutoPlay: {} }; }
      async tvObserveRaw() {
        this.observeCalls += 1;
        return streamObservation();
      }
      async verifyPlayback() {
        return { status: "confirmed", confirmed: true, via: "test" };
      }
      async haService() {
        this.haCalls += 1;
        throw new Error("HA should not be used when Satellite accepts dpad_center");
      }
    }

    installStremioStableClick(FakeClient);
    const client = new FakeClient();
    const result = await client.clickFirstStream();

    assert.equal(result.ok, true);
    assert.equal(result.commandSent, true);
    assert.equal(result.via, "tv_satellite_execute");
    assert.equal(result.centerTransport, "auto");
    assert.equal(client.haCalls, 0);
    assert.equal(fetchCalls, 1);
    assert.ok(client.observeCalls >= 2);
    assert.equal(result.readiness.via, "tv_satellite_stable_stream_list");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("auto transport falls back to Home Assistant when Satellite requests fallback", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({
    ok: false,
    actions: [{ ok: false, action: "dpad_center", fallback: "home_assistant", error: "key_injection_unavailable" }]
  });

  try {
    class FakeClient {
      constructor() {
        this.env = {
          HA_SOL_STREMIO_CENTER_DELAY_MS: "0",
          HA_SOL_STREMIO_STREAM_READY_TIMEOUT_MS: "1000",
          HA_SOL_STREMIO_CENTER_TRANSPORT: "auto"
        };
        this.stremioTvEnabled = true;
        this.stremioTvUrl = "http://tv.local:8765";
        this.stremioTvTimeoutMs = 1000;
        this.stremioFirstStreamDelayMs = 500;
        this.stremioAutoPlayFirstStream = true;
        this.stremioRemoteEntityId = "remote.tv";
        this.haCalls = 0;
      }
      stremioStatus() { return { firstStreamAutoPlay: {} }; }
      async tvObserveRaw() { return streamObservation(); }
      async verifyPlayback() { return { status: "confirmed", confirmed: true, via: "test" }; }
      async haService(domain, service, data) {
        this.haCalls += 1;
        assert.equal(domain, "remote");
        assert.equal(service, "send_command");
        assert.deepEqual(data.command, ["DPAD_CENTER"]);
        return { ok: true };
      }
    }

    installStremioStableClick(FakeClient);
    const client = new FakeClient();
    const result = await client.clickFirstStream();

    assert.equal(result.ok, true);
    assert.equal(result.via, "home_assistant_remote_fallback");
    assert.equal(client.haCalls, 1);
    assert.equal(result.center.satelliteResult.fallback, "home_assistant");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("does not send center when stream list is never confirmed", async () => {
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; return jsonResponse({ ok: true }); };

  try {
    class FakeClient {
      constructor() {
        this.env = {
          HA_SOL_STREMIO_CENTER_DELAY_MS: "0",
          HA_SOL_STREMIO_STREAM_READY_TIMEOUT_MS: "250",
          HA_SOL_STREMIO_CENTER_TRANSPORT: "auto"
        };
        this.stremioTvEnabled = true;
        this.stremioTvUrl = "http://tv.local:8765";
        this.stremioFirstStreamDelayMs = 500;
        this.stremioAutoPlayFirstStream = true;
        this.stremioRemoteEntityId = "remote.tv";
        this.haCalls = 0;
      }
      stremioStatus() { return { firstStreamAutoPlay: {} }; }
      async tvObserveRaw() {
        return {
          package: "com.stremio.one",
          tree: { text: "Back to the Future", children: [] }
        };
      }
      async verifyPlayback() { return { status: "unverified", confirmed: null }; }
      async haService() { this.haCalls += 1; return {}; }
    }

    installStremioStableClick(FakeClient);
    const client = new FakeClient();
    const result = await client.clickFirstStream();

    assert.equal(result.ok, false);
    assert.equal(result.commandSent, false);
    assert.equal(result.reason, "stremio_stream_list_not_stably_visible");
    assert.equal(result.readiness.via, "tv_satellite_timeout_no_click");
    assert.equal(client.haCalls, 0);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("status exposes configurable stream readiness timing and center transport", () => {
  class FakeClient {
    constructor() {
      this.env = {
        HA_SOL_STREMIO_CENTER_DELAY_MS: "1250",
        HA_SOL_STREMIO_STREAM_READY_TIMEOUT_MS: "14000",
        HA_SOL_STREMIO_CENTER_TRANSPORT: "satellite"
      };
      this.stremioTvEnabled = true;
      this.stremioTvUrl = "http://tv.local:8765";
    }
    stremioStatus() { return { firstStreamAutoPlay: { enabled: true } }; }
  }

  installStremioStableClick(FakeClient);
  const status = new FakeClient().stremioStatus();
  assert.equal(status.firstStreamAutoPlay.centerDelayMs, 1250);
  assert.equal(status.firstStreamAutoPlay.readyTimeoutMs, 14000);
  assert.equal(status.firstStreamAutoPlay.centerTransport, "satellite");
  assert.equal(status.firstStreamAutoPlay.blindTimeoutClick, false);
});
