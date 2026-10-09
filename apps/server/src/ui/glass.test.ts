import assert from "node:assert/strict";
import { test } from "node:test";
import { solGlassStyles, solGlassScript } from "./glass.js";
import { solPage, solShellStyles } from "./shell.js";
import { renderOnboardingPage } from "./onboarding.js";

test("Liquid Glass styles expose reduced-motion fallback and mobile layout", () => {
  const css = solGlassStyles();
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /sol-glass-shortcuts/);
  assert.match(css, /backdrop-filter/);
  assert.match(css, /@media\(max-width:680px\)/);
});

test("Liquid Glass enhancement script parses without changing real services", () => {
  const script = solGlassScript();
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /sol-glass-palette/);
  assert.match(script, /MutationObserver/);
  assert.match(script, /decorateHome/);
  assert.match(script, /\/v1\/inputs\/plugins\/extensions\/ui/);
  assert.match(script, /\/v1\/inputs\/plugins\/ui/);
  assert.doesNotMatch(script, /href:'\/system'/);
  assert.doesNotMatch(script, /fetch\s*\(/);
  assert.doesNotMatch(script, /\.submit\s*\(/);
});

test("rendered SOL pages include glass styles and command palette script", () => {
  const html = solPage("life", "Actividad", "<section class=\"page\">Test</section>");
  assert.match(solShellStyles(), /sol-glass-topbar/);
  assert.match(html, /sol-glass-palette/);
  assert.match(html, /Test/);
  assert.match(html, /\/life/);
});

test("authenticated Nexo dashboard receives the same interface enhancement", () => {
  const html = renderOnboardingPage();
  assert.match(html, /sol-glass-palette/);
  assert.match(html, /id="dashboard"/);
});
