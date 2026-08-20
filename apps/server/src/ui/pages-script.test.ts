import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { renderLifePage } from "./life.js";
import { renderMcpPage } from "./mcp.js";
import { renderMercadoLibrePage } from "./mercadolibre.js";

function embeddedScript(html: string, label: string): string {
  const match = html.match(/<script>([\s\S]*?)<\/script>/i);
  assert.ok(match?.[1], `${label} should contain an inline script`);
  return match[1];
}

test("Life page renders syntactically valid embedded JavaScript", () => {
  const script = embeddedScript(renderLifePage(), "Life page");
  assert.doesNotThrow(() => new vm.Script(script, { filename: "life-inline.js" }));
});

test("Mercado Libre page renders syntactically valid embedded JavaScript", () => {
  const script = embeddedScript(renderMercadoLibrePage(), "Mercado Libre page");
  assert.doesNotThrow(() => new vm.Script(script, { filename: "mercadolibre-inline.js" }));
});

test("MCP page renders syntactically valid embedded JavaScript", () => {
  const script = embeddedScript(renderMcpPage(), "MCP page");
  assert.doesNotThrow(() => new vm.Script(script, { filename: "mcp-inline.js" }));
});

test("Life family visibility confirmation keeps newline escaped in rendered JavaScript", () => {
  const html = renderLifePage();
  assert.match(html, /visible para la familia\?\\nAceptar/);
});
