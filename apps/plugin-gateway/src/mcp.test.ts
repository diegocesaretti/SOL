import assert from "node:assert/strict";
import test from "node:test";
import { findCapabilities } from "./mcp.js";
import type { BridgeCatalog, RemoteToolDefinition } from "./state.js";

function tool(name: string, description: string, requiredScope: "read" | "submit" | "actions" = "read"): RemoteToolDefinition {
  return {
    name,
    description,
    requiredScope,
    inputSchema: { type: "object", properties: {} },
  };
}

const catalog: BridgeCatalog = {
  instanceId: "test",
  updatedAt: Date.now(),
  tools: [
    tool("home_assistant_search_states", "Search cached entities by id, friendly name, device or area."),
    tool("home_assistant_tv_status", "Report Home Assistant-only Android TV control status."),
    tool("home_assistant_call_service", "Execute a Home Assistant service.", "actions"),
    tool("memory_search", "Search explicit durable SOL memories visible to the member."),
    tool("search_whatsapp", "Search observed WhatsApp history stored by Nexo."),
    tool("home_assistant_stremio_play_best", "Play the best Stremio stream.", "actions"),
  ],
};
test("Spanish TV query finds Home Assistant TV tools", () => {
  const matches = findCapabilities(catalog, ["sol.read", "sol.actions"], "tele cocina prendida", 5);
  assert.ok(matches.some((item) => item.name === "home_assistant_tv_status"));
  assert.ok(matches.some((item) => item.name === "home_assistant_search_states"));
});

test("memory query prioritizes memory search", () => {
  const matches = findCapabilities(catalog, ["sol.read"], "qué recuerda la memoria", 3);
  assert.equal(matches[0]?.name, "memory_search");
});

test("capability search respects OAuth scopes", () => {
  const readOnly = findCapabilities(catalog, ["sol.read"], "apagar aire", 8);
  assert.equal(readOnly.some((item) => item.requiredScope === "actions"), false);

  const withActions = findCapabilities(catalog, ["sol.read", "sol.actions"], "apagar aire", 8);
  assert.equal(withActions.some((item) => item.name === "home_assistant_call_service"), true);
});