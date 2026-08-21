import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { renderAiPage } from "./ai.js";
import { renderInputsPage } from "./inputs.js";
import { renderLifePage } from "./life.js";
import { renderMcpPage } from "./mcp.js";
import { renderMercadoLibrePage } from "./mercadolibre.js";
import { renderOnboardingPage } from "./onboarding.js";
import { renderOutputsPage } from "./outputs.js";

function embeddedScript(html: string, label: string): string {
  const match = html.match(/<script>([\s\S]*?)<\/script>/i);
  assert.ok(match?.[1], `${label} should contain an inline script`);
  return match[1];
}

for (const [label, render, filename] of [
  ["Life page", renderLifePage, "life-inline.js"],
  ["Inputs page", renderInputsPage, "inputs-inline.js"],
  ["Outputs page", renderOutputsPage, "outputs-inline.js"],
  ["AI page", renderAiPage, "ai-inline.js"],
  ["Mercado Libre advanced page", renderMercadoLibrePage, "mercadolibre-inline.js"],
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

test("Life keeps long source bodies compact and exposes Intelligence Gate state", () => {
  const html = renderLifePage();
  assert.match(html, /Ver más/);
  assert.match(html, /gate · sólo Life/);
  assert.match(html, /intelligenceRoutes/);
});

test("Inputs explains destructive source removal before deleting", () => {
  const html = renderInputsPage();
  assert.match(html, /también borrará de SOL los datos importados/);
});

test("Inputs exposes Gmail as a read-only provider", () => {
  const html = renderInputsPage();
  assert.match(html, /data-provider="gmail"/);
  assert.match(html, /permiso Gmail de lectura/);
});

test("Inputs exposes live WhatsApp ingestion diagnostics", () => {
  const html = renderInputsPage();
  assert.match(html, /Diagnóstico WhatsApp/);
  assert.match(html, /Baileys todavía no entregó ningún mensaje/);
  assert.match(html, /lastIngestError/);
});

test("Outputs exposes member proactivity controls", () => {
  const html = renderOutputsPage();
  assert.match(html, /Proactividad/);
  assert.match(html, /pro-morning-time/);
  assert.match(html, /pro-tomorrow-time/);
  assert.match(html, /\/v1\/executive\/proactivity/);
});
