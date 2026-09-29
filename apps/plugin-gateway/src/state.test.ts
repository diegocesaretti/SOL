import assert from "node:assert/strict";
import test from "node:test";
import {
  authenticateBridge,
  consumePairCode,
  enrollBridge,
  getBridgeCatalog,
  issuePairCode,
  updateBridgeCatalog,
} from "./state.js";

test("bridge enrollment token authenticates and catalog is member-instance scoped", () => {
  const enrolled = enrollBridge();
  assert.equal(authenticateBridge(`Bearer ${enrolled.bridgeToken}`), enrolled.instanceId);
  const catalog = updateBridgeCatalog(enrolled.instanceId, {
    profile: { displayName: "Tester" },
    tools: [{
      name: "home_assistant_get_state",
      description: "Read an entity state.",
      inputSchema: { type: "object", properties: { entity_id: { type: "string" } }, required: ["entity_id"] },
      requiredScope: "read",
      annotations: { readOnlyHint: true },
    }],
  });
  assert.equal(catalog.tools.length, 1);
  assert.equal(getBridgeCatalog(enrolled.instanceId)?.profile?.displayName, "Tester");
});

test("pair codes are single-use", () => {
  const enrolled = enrollBridge();
  const pair = issuePairCode(enrolled.instanceId, ["read", "actions"]);
  const first = consumePairCode(pair.code);
  assert.equal(first?.instanceId, enrolled.instanceId);
  assert.deepEqual(first?.allowedScopes, ["read", "actions"]);
  assert.equal(consumePairCode(pair.code), null);
});
