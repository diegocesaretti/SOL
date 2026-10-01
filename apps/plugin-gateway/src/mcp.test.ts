import assert from "node:assert/strict";
import test from "node:test";
import { FACADE_ALIASES, findCapabilities, publicAnnotations } from "./mcp.js";
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
    tool("send_whatsapp", "Send one WhatsApp text using the dedicated output account.", "actions"),
    tool("home_assistant_stremio_play_best", "Play the best Stremio stream.", "actions"),
    tool("home_assistant_youtube_play", "Play and verify a concrete YouTube video on the configured TV.", "actions"),
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

test("public facade exposes the dedicated YouTube playback tool", () => {
  const alias = FACADE_ALIASES.find((item) => item.publicName === "sol_youtube_play");
  assert.equal(alias?.remoteName, "home_assistant_youtube_play");
});

test("YouTube query resolves to the dedicated playback tool", () => {
  const matches = findCapabilities(catalog, ["sol.read", "sol.actions"], "poné un video de youtube", 5);
  assert.equal(matches[0]?.name, "home_assistant_youtube_play");
});

test("public facade exposes WhatsApp sending with irreversible-send metadata", () => {
  const alias = FACADE_ALIASES.find((item) => item.publicName === "sol_whatsapp_send");
  assert.equal(alias?.remoteName, "send_whatsapp");
  assert.equal(alias?.annotations.openWorldHint, true);
  assert.equal(alias?.annotations.destructiveHint, true);
});

test("capability search respects OAuth scopes", () => {
  const readOnly = findCapabilities(catalog, ["sol.read"], "apagar aire", 8);
  assert.equal(readOnly.some((item) => item.requiredScope === "actions"), false);

  const withActions = findCapabilities(catalog, ["sol.read", "sol.actions"], "apagar aire", 8);
  assert.equal(withActions.some((item) => item.name === "home_assistant_call_service"), true);
});
test("public annotations mark external actions as open-world and irreversible sends as destructive", () => {
  const annotations = publicAnnotations(tool("send_whatsapp", "Send WhatsApp.", "actions"));
  assert.equal(annotations.openWorldHint, true);
  assert.equal(annotations.destructiveHint, true);
  assert.equal(annotations.readOnlyHint, false);
});

test("public annotations keep playback/navigation non-destructive", () => {
  const youtube = publicAnnotations(tool("home_assistant_youtube_play", "Play YouTube.", "actions"));
  assert.equal(youtube.openWorldHint, true);
  assert.equal(youtube.destructiveHint, false);

  const stremio = publicAnnotations(tool("home_assistant_stremio_search", "Search Stremio.", "read"));
  assert.equal(stremio.openWorldHint, true);
  assert.equal(stremio.destructiveHint, false);
  assert.equal(stremio.readOnlyHint, true);
});

test("public annotations keep bounded cached Home Assistant reads closed-world", () => {
  const annotations = publicAnnotations(tool("home_assistant_get_state", "Read cached state.", "read"));
  assert.equal(annotations.openWorldHint, false);
  assert.equal(annotations.readOnlyHint, true);
  assert.equal(annotations.destructiveHint, false);
});

test("public annotations mark submit tools open-world while preserving additive writes", () => {
  const annotations = publicAnnotations(tool("save_observation", "Save observation.", "submit"));
  assert.equal(annotations.openWorldHint, true);
  assert.equal(annotations.destructiveHint, false);
});
