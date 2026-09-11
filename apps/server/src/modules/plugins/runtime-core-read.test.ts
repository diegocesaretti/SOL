import assert from "node:assert/strict";
import test from "node:test";
import { searchPluginRuntimeWhatsapp } from "./runtime-core-read.js";
import type { SolPluginRuntimePrincipal } from "./types.js";

const principal: SolPluginRuntimePrincipal = {
  pluginId: "nexo-whatsapp",
  householdId: "00000000-0000-0000-0000-000000000001",
  memberId: "00000000-0000-0000-0000-000000000002",
  permissions: ["mcp.invoke.read"],
};

test("plugin runtime WhatsApp search rejects an undersized query before database access", async () => {
  await assert.rejects(
    () => searchPluginRuntimeWhatsapp(principal, { query: "x", limit: 10 }),
    /whatsapp_search_query_invalid/,
  );
});

test("plugin runtime WhatsApp search rejects missing query before database access", async () => {
  await assert.rejects(
    () => searchPluginRuntimeWhatsapp(principal, {}),
    /whatsapp_search_query_invalid/,
  );
});
