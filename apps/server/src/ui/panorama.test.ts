import assert from "node:assert/strict";
import { Script } from "node:vm";
import { test } from "node:test";
import { renderPanoramaPage } from "./panorama.js";

test("panorama produces navigable HTML with scoped read-only data sources", () => {
  const html = renderPanoramaPage();
  assert.match(html, /Panorama contextual/);
  assert.match(html, /Lo importante, antes de preguntar/);
  assert.match(html, /\/v1\/life\/timeline\?limit=80/);
  assert.match(html, /\/v1\/knowledge\/entities\?kind=project/);
  assert.match(html, /\/v1\/auth\/me/);
  assert.match(html, /credentials:'same-origin'/);
  assert.match(html, /solo lectura/);
  assert.doesNotMatch(html, /fetch\([^;]*method\s*:\s*['"](?:POST|PATCH|DELETE)/i);
});

test("client-side panorama script parses after rendering", () => {
  const html = renderPanoramaPage();
  const script = html.split("<script>")[1]?.split("</script>")[0];
  assert.ok(script, "inline view script exists");
  assert.doesNotThrow(() => new Script(script));
});

test("forecast distinguishes explicit structured deadlines from inferred text", () => {
  const html = renderPanoramaPage();
  assert.match(html, /e\.type!=='task'/);
  assert.match(html, /e\.metadata\.dueAt/);
  assert.match(html, /Ninguna inferencia se presenta como certeza/);
});
