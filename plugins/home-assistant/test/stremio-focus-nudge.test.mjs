import test from "node:test";
import assert from "node:assert/strict";
import { installStremioStableClick } from "../lib/stremio-stable-click.mjs";

function makeClient(env = {}) {
  class FakeClient {
    constructor() {
      this.env = {
        HA_SOL_STREMIO_CENTER_TRANSPORT: "home_assistant",
        HA_SOL_STREMIO_FOCUS_NUDGE_DELAY_MS: "0",
        ...env
      };
      this.stremioAutoPlayFirstStream = true;
      this.stremioRemoteEntityId = "remote.tv_cocina";
      this.stremioTvEnabled = false;
      this.stremioTvUrl = "";
      this.stremioFirstStreamDelayMs = 0;
      this.calls = [];
    }

    stremioStatus() {
      return { firstStreamAutoPlay: {} };
    }

    async haService(domain, service, data) {
      this.calls.push({ domain, service, data });
      return { ok: true };
    }

    async verifyPlayback() {
      return { status: "unverified", confirmed: null };
    }
  }

  installStremioStableClick(FakeClient);
  return new FakeClient();
}

test("HA-only Stremio autoplay nudges focus right-left before center", async () => {
  const client = makeClient({ HA_SOL_STREMIO_FOCUS_NUDGE: "right_left" });
  const result = await client.clickFirstStream();

  assert.equal(result.ok, true);
  assert.deepEqual(result.commands, ["DPAD_RIGHT", "DPAD_LEFT", "DPAD_CENTER"]);
  assert.deepEqual(client.calls.map((call) => call.data), [
    { entity_id: "remote.tv_cocina", command: ["DPAD_RIGHT"] },
    { entity_id: "remote.tv_cocina", command: ["DPAD_LEFT"] },
    { entity_id: "remote.tv_cocina", command: ["DPAD_CENTER"] }
  ]);
});

test("focus nudge can be disabled and preserves the known-good center payload", async () => {
  const client = makeClient({ HA_SOL_STREMIO_FOCUS_NUDGE: "off" });
  const result = await client.clickFirstStream();

  assert.equal(result.ok, true);
  assert.deepEqual(result.commands, ["DPAD_CENTER"]);
  assert.deepEqual(client.calls.map((call) => call.data), [
    { entity_id: "remote.tv_cocina", command: ["DPAD_CENTER"] }
  ]);
});

test("status exposes focus nudge configuration", () => {
  const client = makeClient({
    HA_SOL_STREMIO_FOCUS_NUDGE: "right_left",
    HA_SOL_STREMIO_FOCUS_NUDGE_DELAY_MS: "275"
  });
  const status = client.stremioStatus();

  assert.equal(status.firstStreamAutoPlay.focusNudge, "right_left");
  assert.equal(status.firstStreamAutoPlay.focusNudgeDelayMs, 275);
});
