import test from "node:test";
import assert from "node:assert/strict";
import { pluginApiTimeoutMs } from "./lib/sol-client-core.mjs";

test("Codex Panorama investigation is not aborted by normal short plugin API timeout", () => {
  assert.equal(pluginApiTimeoutMs("/v1/plugin-api/panorama/investigate"), 300000);
  assert.equal(pluginApiTimeoutMs("/v1/plugin-api/panorama/latest"), 10000);
  assert.equal(pluginApiTimeoutMs("/v1/plugin-api/mcp/tools/register"), 10000);
});
