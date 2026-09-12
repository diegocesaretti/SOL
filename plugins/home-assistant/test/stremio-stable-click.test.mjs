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

test("sends DPAD_CENTER only after stable stream-list confirmation", async () => {
  class FakeClient {
    constructor() {
      this.env = {
        HA_SOL_STREMIO_CENTER_DELAY_MS: "0",
        HA_SOL_STREMIO_STREAM_READY_TIMEOUT_MS: "1000"
      };
      this.stremioTvEnabled = true;
      this.stremioTvUrl = "http://tv.local:8765";
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
    async haService(domain, service, data) {
      this.haCalls += 1;
      assert.equal(domain, "remote");
      assert.equal(service, "send_command");
      assert.equal(data.command, "DPAD_CENTER");
      return { ok: true };
    }
  }

  installStremioStableClick(FakeClient);
  const client = new FakeClient();
  const result = await client.clickFirstStream();

  assert.equal(result.ok, true);
  assert.equal(result.commandSent, true);
  assert.equal(client.haCalls, 1);
  assert.ok(client.observeCalls >= 2);
  assert.equal(result.readiness.via, "tv_satellite_stable_stream_list");
  assert.ok(result.readiness.confirmations >= 2);
});

test("does not send DPAD_CENTER when stream list is never confirmed", async () => {
  class FakeClient {
    constructor() {
      this.env = {
        HA_SOL_STREMIO_CENTER_DELAY_MS: "0",
        HA_SOL_STREMIO_STREAM_READY_TIMEOUT_MS: "250"
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
    async verifyPlayback() {
      return { status: "unverified", confirmed: null };
    }
    async haService() {
      this.haCalls += 1;
      return {};
    }
  }

  installStremioStableClick(FakeClient);
  const client = new FakeClient();
  const result = await client.clickFirstStream();

  assert.equal(result.ok, false);
  assert.equal(result.commandSent, false);
  assert.equal(result.reason, "stremio_stream_list_not_stably_visible");
  assert.equal(result.readiness.via, "tv_satellite_timeout_no_click");
  assert.equal(client.haCalls, 0);
});

test("status exposes configurable stream readiness timing", () => {
  class FakeClient {
    constructor() {
      this.env = {
        HA_SOL_STREMIO_CENTER_DELAY_MS: "1250",
        HA_SOL_STREMIO_STREAM_READY_TIMEOUT_MS: "14000"
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
  assert.equal(status.firstStreamAutoPlay.blindTimeoutClick, false);
});
