import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const base = new URL("./", import.meta.url);
test("Pulse MCP tool names use plugin id prefix required by SOL registry", async () => {
  const code = await readFile(new URL("index.mjs", base), "utf8");
  const declared = [...code.matchAll(/\{name:"(pulse_[a-z0-9_]+)",description:/g)].map(m => m[1]);
  assert.deepEqual(declared, [
    "pulse_engine_status", "pulse_engine_events", "pulse_engine_decisions", "pulse_engine_ingest_event",
  ]);
  for (const name of declared) {
    assert.match(code, new RegExp("name===\\\"" + name + "\\\""));
  }
  const manifest = JSON.parse(await readFile(new URL("sol-plugin.json", base), "utf8"));
  assert.equal(manifest.id, "pulse-engine");
  assert.equal(manifest.version, "0.7.2");
  assert.match(code, /version:"0\.7\.2"/);
});
