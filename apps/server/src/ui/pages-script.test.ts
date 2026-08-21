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
import { solSidebar } from "./shell.js";

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
  ["Nexo home", renderOnboardingPage, "home-inline.js"],
] as const) {
  test(`${label} renders syntactically valid embedded JavaScript`, () => {
    const script = embeddedScript(render(), label);
    assert.doesNotThrow(() => new vm.Script(script, { filename }));
  });
}

test("primary shell brands the product as Nexo and keeps the prototype navigation narrow", () => {
  const sidebar = solSidebar("home");
  assert.match(sidebar, /NEXO/);
  assert.match(sidebar, /WhatsApp/);
  assert.match(sidebar, /Life/);
  assert.match(sidebar, /MCP/);
  assert.doesNotMatch(sidebar, />Outputs</);
  assert.doesNotMatch(sidebar, />AI</);
});

test("Nexo home presents Codex as the assistant and Nexo as memory/context", () => {
  const html = renderOnboardingPage();
  assert.match(html, /Codex es el asistente/);
  assert.match(html, /Nexo le aporta/);
  assert.match(html, /Gmail → Codex/);
  assert.match(html, /Home Assistant → MCP propio/);
});

test("Life family visibility confirmation keeps newline escaped in rendered JavaScript", () => {
  const html = renderLifePage();
  assert.match(html, /Visible para la familia\?\\nAceptar/);
});

test("Life keeps long source bodies compact and exposes Intelligence Gate state", () => {
  const html = renderLifePage();
  assert.match(html, /Ver más/);
  assert.match(html, /gate · sólo Life/);
  assert.match(html, /intelligenceRoutes/);
  assert.match(html, /Codex es quien interpreta/);
});

test("Nexo MCP page generates the new Codex configuration contract", () => {
  const html = renderMcpPage();
  assert.match(html, /Darle memoria a Codex/);
  assert.match(html, /NEXO_MCP_TOKEN/);
  assert.match(html, /mcpServers/);
  assert.match(html, /nexo/);
  assert.match(html, /remember_fact/);
  assert.match(html, /pnpm mcp:legacy/);
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

test("Legacy Outputs page remains syntactically valid during the prototype", () => {
  const html = renderOutputsPage();
  assert.match(html, /Proactividad/);
  assert.match(html, /pro-morning-time/);
  assert.match(html, /pro-tomorrow-time/);
  assert.match(html, /\/v1\/executive\/proactivity/);
});
