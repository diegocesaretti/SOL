import assert from "node:assert/strict";
import test from "node:test";
import { renderInputsPage } from "./inputs.js";

test("Connections page inline browser script parses", () => {
  const html = renderInputsPage();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");
  assert.ok(scripts.length > 0, "Connections page should contain a browser script");
  for (const script of scripts) {
    assert.doesNotThrow(() => new Function(script));
  }
});
