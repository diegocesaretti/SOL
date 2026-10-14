import assert from "node:assert/strict";
import test from "node:test";
import { renderSystemPage } from "./system.js";

test("System page inline browser script parses", () => {
  const html = renderSystemPage();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");
  assert.ok(scripts.length > 0, "System page should contain a browser script");
  for (const script of scripts) {
    assert.doesNotThrow(() => new Function(script));
  }
});

test("System settings expose a persistent SOL color theme editor", () => {
  const html=renderSystemPage();
  for(const color of ["accent","background","panel","text","glow"]){
    assert.match(html,new RegExp('data-theme-color="'+color+'"'));
  }
  assert.match(html,/sol\.appearance\.v1/);
  assert.match(html,/id="theme-reset"/);
  assert.match(html,/SOLTheme\.set/);
  assert.match(html,/window\.addEventListener\("storage"/);
});
