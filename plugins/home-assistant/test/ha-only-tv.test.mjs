import assert from "node:assert/strict";
import test from "node:test";
import { __test } from "../lib/ha-only-tv.mjs";

test("HA-only TV navigate sends one Home Assistant command array and never needs Satellite", async () => {
  const calls = [];
  const client = {
    stremioRemoteEntityId: "remote.tv",
    async haService(domain, service, data) {
      calls.push({ domain, service, data });
      return [{ ok: true }];
    }
  };

  const result = await __test.handleTvTool(client, "home_assistant_tv_navigate", {
    direction: "right",
    count: 3
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "home_assistant_only");
  assert.equal(result.via, "home_assistant_remote");
  assert.equal(result.satelliteUsed, false);
  assert.deepEqual(result.commands, ["DPAD_RIGHT", "DPAD_RIGHT", "DPAD_RIGHT"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].domain, "remote");
  assert.equal(calls[0].service, "send_command");
  assert.equal(calls[0].data.entity_id, "remote.tv");
  assert.deepEqual(calls[0].data.command, ["DPAD_RIGHT", "DPAD_RIGHT", "DPAD_RIGHT"]);
});

test("HA-only TV path preserves order and caps special keys to one press", async () => {
  const calls = [];
  const client = {
    env: { HA_SOL_TV_REMOTE_ENTITY_ID: "remote.living_room" },
    async haService(domain, service, data) {
      calls.push({ domain, service, data });
      return [];
    }
  };

  const result = await __test.handleTvTool(client, "home_assistant_tv_navigate_path", {
    moves: [
      { direction: "right", count: 2 },
      { direction: "down", count: 1 },
      { direction: "center", count: 5 }
    ]
  });

  assert.equal(result.satelliteUsed, false);
  assert.equal(result.totalKeypresses, 4);
  assert.deepEqual(result.commands, ["DPAD_RIGHT", "DPAD_RIGHT", "DPAD_DOWN", "DPAD_CENTER"]);
  assert.equal(calls.length, 1);
});

test("HA-only TV status exposes no visual observation capability", async () => {
  const result = await __test.handleTvTool({ stremioRemoteEntityId: "remote.tv" }, "home_assistant_tv_status", {});
  assert.equal(result.mode, "home_assistant_only");
  assert.equal(result.satelliteUsed, false);
  assert.equal(result.visualObservationAvailable, false);
  assert.equal(result.remoteConfigured, true);
});
