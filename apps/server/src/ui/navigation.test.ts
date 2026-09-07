import assert from "node:assert/strict";
import test from "node:test";
import { renderAiPage } from "./ai.js";
import { renderInputsPage } from "./inputs.js";
import { renderLifePage } from "./life.js";
import { renderMcpPage } from "./mcp.js";
import { renderOnboardingPage } from "./onboarding.js";
import { renderOutputsPage } from "./outputs.js";
import { renderPluginsPage } from "./plugins.js";
import { solSidebar } from "./shell.js";

const renderedPages = [
  ["home", renderOnboardingPage()],
  ["inputs", renderInputsPage()],
  ["outputs", renderOutputsPage()],
  ["life", renderLifePage()],
  ["mcp", renderMcpPage()],
  ["ai", renderAiPage()],
  ["services", renderPluginsPage()],
] as const;
const pages = renderedPages.map(([, html]) => html).join("\n");

const removedNativeSurfaces = [
  "/whatsapp?advanced=1",
  "/calendar?advanced=1",
  "/home-assistant?advanced=1",
  "/mercadolibre?advanced=1",
  "/sol-whatsapp?advanced=1",
  "/executive?advanced=1",
  "/v1/whatsapp/",
  "/v1/gmail/",
  "/v1/calendar/",
  "/v1/home-assistant/",
  "/v1/mercadolibre/",
  "/v1/sol-whatsapp",
  "/v1/executive/",
];

test("current SOL UI does not link to removed native provider surfaces", () => {
  for (const route of removedNativeSurfaces) assert.equal(pages.includes(route), false, `removed route leaked into UI: ${route}`);
});

test("sidebar exposes every canonical SOL page", () => {
  const html = solSidebar("home");
  for (const route of ["/", "/services", "/inputs", "/outputs", "/life", "/mcp", "/ai"]) {
    assert.match(html, new RegExp(`href=\\"${route === "/" ? "\\/" : route.replaceAll("/", "\\/")}\\"`));
  }
});

test("all embedded UI scripts are syntactically valid JavaScript", () => {
  for (const [name, html] of renderedPages) {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");
    for (const script of scripts) {
      assert.doesNotThrow(() => new Function(script), `${name} contains invalid embedded JavaScript`);
    }
  }
});
