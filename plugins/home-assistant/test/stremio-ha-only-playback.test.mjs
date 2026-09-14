import test from "node:test";
import assert from "node:assert/strict";
import { SolPluginClient } from "../lib/sol-client.mjs";
import { installStremioLaunchGuard } from "../lib/stremio-launch-guard.mjs";

test("generic first-stream click uses only Home Assistant remote commands", async () => {
  const calls = [];
  const client = new SolPluginClient({
    HA_SOL_STREMIO_REMOTE_ENTITY_ID: "remote.tv",
    HA_SOL_STREMIO_FIRST_STREAM_DELAY_MS: "0",
    HA_SOL_STREMIO_FOCUS_NUDGE: "off"
  });
  client.haService = async (domain, service, payload) => {
    calls.push({ domain, service, payload });
    return { ok: true };
  };
  const result = await client.clickFirstStream();
  assert.equal(result.ok, true);
  assert.equal(result.commandSent, true);
  assert.deepEqual(result.commands, ["DPAD_CENTER"]);
  assert.deepEqual(calls, [{
    domain: "remote",
    service: "send_command",
    payload: { entity_id: "remote.tv", command: ["DPAD_CENTER"] }
  }]);
});

test("generic focus nudge remains configurable without Satellite", async () => {
  const commands = [];
  const client = new SolPluginClient({
    HA_SOL_STREMIO_REMOTE_ENTITY_ID: "remote.tv",
    HA_SOL_STREMIO_FIRST_STREAM_DELAY_MS: "0",
    HA_SOL_STREMIO_FOCUS_NUDGE: "right_left",
    HA_SOL_STREMIO_FOCUS_NUDGE_DELAY_MS: "0"
  });
  client.haService = async (_domain, _service, payload) => {
    commands.push(payload.command[0]);
    return { ok: true };
  };
  const result = await client.clickFirstStream();
  assert.equal(result.ok, true);
  assert.deepEqual(commands, ["DPAD_RIGHT", "DPAD_LEFT", "DPAD_CENTER"]);
});

test("launch guard only wakes through Home Assistant before a detail deep link", async () => {
  class FakeClient {
    constructor() {
      this.stremioRemoteEntityId = "remote.tv";
      this.calls = [];
    }
    stremioStatus() { return {}; }
    async haService(domain, service, payload) {
      this.calls.push({ domain, service, payload });
      return { ok: true };
    }
    async launchStremio(uri) {
      this.calls.push({ launch: uri });
      return { ok: true, deepLink: uri };
    }
    async handleStremioTool() {
      return this.launchStremio("stremio:///detail/movie/tt1/tt1?autoPlay=true");
    }
  }
  installStremioLaunchGuard(FakeClient, { wakeDelayMs: 0 });
  const client = new FakeClient();
  const result = await client.handleStremioTool("home_assistant_stremio_play_best", { id: "tt1" });
  assert.equal(result.launchGuard.ok, true);
  assert.equal(result.launchGuard.visualWatchdog, false);
  assert.deepEqual(client.calls[0].payload.command, ["0"]);
  assert.ok(client.calls[1].launch.startsWith("stremio:///detail/"));
});
