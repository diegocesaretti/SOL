import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { renderInputsPage } from "./inputs.js";
import { renderLifePage } from "./life.js";
import { renderMcpPage } from "./mcp.js";
import { renderMercadoLibrePage } from "./mercadolibre.js";
import { renderOnboardingPage } from "./onboarding.js";

function embeddedScript(html: string, label: string): string {
  const match = html.match(/<script>([\s\S]*?)<\/script>/i);
  assert.ok(match?.[1], `${label} should contain an inline script`);
  return match[1];
}

for (const [label, render, filename] of [
  ["Life page", renderLifePage, "life-inline.js"],
  ["Inputs page", renderInputsPage, "inputs-inline.js"],
  ["Mercado Libre page", renderMercadoLibrePage, "mercadolibre-inline.js"],
  ["MCP page", renderMcpPage, "mcp-inline.js"],
  ["SOL home", renderOnboardingPage, "home-inline.js"],
] as const) {
  test(`${label} renders syntactically valid embedded JavaScript`, () => {
    const script = embeddedScript(render(), label);
    assert.doesNotThrow(() => new vm.Script(script, { filename }));
  });
}

test("Life family visibility confirmation keeps newline escaped in rendered JavaScript", () => {
  const html = renderLifePage();
  assert.match(html, /Visible para la familia\?\\nAceptar/);
});

test("Inputs explains destructive source removal before deleting", () => {
  const html = renderInputsPage();
  assert.match(html, /también borrará de SOL los datos importados/);
});
