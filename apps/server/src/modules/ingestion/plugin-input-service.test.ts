import assert from "node:assert/strict";
import test from "node:test";
import { pluginRuntimeOwnsInput } from "./plugin-input-service.js";

const principal = { pluginId: "nexo-whatsapp", memberId: "member-a" };

test("plugin runtime owns its private input", () => {
  assert.equal(pluginRuntimeOwnsInput(principal, {
    owner_member_id: "member-a",
    auth_mode: "plugin:nexo-whatsapp",
  }), true);
});

test("plugin runtime still owns its family/shared input", () => {
  assert.equal(pluginRuntimeOwnsInput(principal, {
    owner_member_id: null,
    auth_mode: "plugin:nexo-whatsapp",
  }), true);
});

test("plugin runtime cannot adopt another member's private input", () => {
  assert.equal(pluginRuntimeOwnsInput(principal, {
    owner_member_id: "member-b",
    auth_mode: "plugin:nexo-whatsapp",
  }), false);
});

test("shared visibility does not allow a different plugin runtime", () => {
  assert.equal(pluginRuntimeOwnsInput(principal, {
    owner_member_id: null,
    auth_mode: "plugin:other-plugin",
  }), false);
});
