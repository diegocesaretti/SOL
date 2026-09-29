import assert from "node:assert/strict";
import test from "node:test";
import { renderMcpPage } from "./mcp.js";

test("MCP page inline browser script parses", () => {
  const html = renderMcpPage();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");
  assert.ok(scripts.length > 0, "MCP page should contain a browser script");
  for (const script of scripts) {
    assert.doesNotThrow(() => new Function(script));
  }
});
