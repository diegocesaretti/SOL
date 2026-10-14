import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { test } from "node:test";

test("bundled neural viewer exposes offline Three.js and an authenticated-only data fetch", () => {
  const html = readFileSync(new URL("../../assets/panorama-neural.html", import.meta.url), "utf8");
  assert.match(html, /\/panorama\/three\.min\.js/);
  assert.match(html, /\/v1\/panorama\/network/);
  assert.match(html, /screensaver/);
  assert.match(html, /embed/);
  const scripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g), match => match[1]);
  assert.equal(scripts.length, 2, "the viewer and data adapter both have an inline script");
  scripts.forEach((code, index) => assert.doesNotThrow(() => new Script(code), "inline script " + index));
});

test("vendored Three.js is available for fully offline SOL rendering", () => {
  const code = readFileSync(new URL("../../assets/three-r152.min.js", import.meta.url), "utf8");
  assert.match(code, /three\.js/);
  assert.ok(code.length > 100_000);
});
