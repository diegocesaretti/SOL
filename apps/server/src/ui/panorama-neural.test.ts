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

test("constellation persists settings and exposes density without embedding-specific overrides", () => {
  const html=readFileSync(new URL("../../assets/panorama-neural.html",import.meta.url),"utf8");
  assert.match(html,/sol\.neural\.preferences\.v1/);
  assert.match(html,/localStorage\.setItem\(PREF_KEY/);
  assert.match(html,/addEventListener\('storage'/);
  assert.match(html,/id="densityRange"/);
  assert.match(html,/setDensity\(density=60\)/);
  assert.match(html,/getPreferences\(\)/);
  assert.match(html,/focus\.settled/);
  assert.match(html,/performance\.now\(\)-stableSince<1200/);
  assert.doesNotMatch(html,/if\(mode==="embed"\)\{net\.setAutoFocus/);
  assert.doesNotMatch(html,/if\(mode==="screensaver"\)\{net\.setAutoFocus/);
  assert.match(html,/camera\.left=-6\*aspect/);
  assert.match(html,/camera\.right=6\*aspect/);
});


test("mesh and atmospheric controls are present and persistent across Panorama views", () => {
  const html=readFileSync(new URL("../../assets/panorama-neural.html",import.meta.url),"utf8");
  for(const id of ["topologySelect","curveRange","glitchRange","backgroundMode","grainToggle","imageToggle"]){
    assert.match(html,new RegExp('id="'+id+'"'));
  }
  assert.match(html,/value="mesh">Connected network mesh/);
  assert.match(html,/value="clusters">Clustered branches/);
  assert.match(html,/value="plain">Plain solid color/);
  assert.match(html,/showImage:styleState\.showImage/);
  assert.match(html,/backgroundMode:styleState\.backgroundMode/);
  assert.match(html,/grain:styleState\.grain/);
  assert.match(html,/curve:styleState\.curve/);
  assert.match(html,/glitch:styleState\.glitch/);
  assert.match(html,/topology:styleState\.topology/);
  assert.match(html,/localStorage\.setItem\(PREF_KEY/);
  assert.match(html,/addEventListener\('storage'/);
  assert.match(html,/ai-topology-changed/);
  assert.match(html,/net\.getPreferences\(\)\.topology==='mesh'/);
  assert.match(html,/kind:"visual-mesh"/);
  assert.match(html,/e\.visual=false/);
  assert.match(html,/sampleWorldEdge/);
  assert.match(html,/updateElectricArcs/);
  assert.match(html,/auxGroup\.visible=styleState\.backgroundMode!=='plain'/);
  assert.doesNotMatch(html,/net\.setReferenceOverlay\(true,\.13\)/);
});
test("glitch animation pools GPU buffers instead of new per-frame meshes",()=>{
  const html=readFileSync(new URL("../../assets/panorama-neural.html",import.meta.url),"utf8");
  assert.match(html,/new Float32Array\(maxArcs\*steps\*6\)/);
  assert.match(html,/positions\.needsUpdate=true/);
  assert.match(html,/if\(t-lastArcUpdate<\.11\)return/);
  assert.match(html,/render3d=\{render,rebuild:buildGraph,refresh:buildGraph/);
});
