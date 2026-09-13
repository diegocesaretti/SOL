import assert from "node:assert/strict";
import test from "node:test";
import { installHaRemoteCommandNormalization } from "../lib/ha-remote-normalize.mjs";

test("single Home Assistant remote command is sent as a string", async () => {
  class Client {
    async haService(domain, service, data) {
      return { domain, service, data };
    }
  }

  installHaRemoteCommandNormalization(Client);
  const client = new Client();
  const result = await client.haService("remote", "send_command", {
    entity_id: "remote.tv",
    command: ["DPAD_CENTER"]
  });

  assert.equal(result.data.command, "DPAD_CENTER");
  assert.equal(result.data.entity_id, "remote.tv");
});

test("multiple Home Assistant remote commands remain an ordered list", async () => {
  class Client {
    async haService(domain, service, data) {
      return { domain, service, data };
    }
  }

  installHaRemoteCommandNormalization(Client);
  const client = new Client();
  const commands = ["DPAD_RIGHT", "DPAD_RIGHT", "DPAD_CENTER"];
  const result = await client.haService("remote", "send_command", {
    entity_id: "remote.tv",
    command: commands
  });

  assert.deepEqual(result.data.command, commands);
});
