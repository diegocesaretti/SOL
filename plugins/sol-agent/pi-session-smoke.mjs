import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiDecisionSession } from "./pi-adapter.mjs";

// CI only: real Pi SDK session creation WITHOUT a model request, external tools,
// secrets, Home Assistant, Mercado Libre, or any SOL service.
const dir = await mkdtemp(join(tmpdir(), "sol-pi-smoke-"));
try {
  const session = await createPiDecisionSession({
    provider: "openai", modelId: "gpt-4.1",
    apiKey: "ci-testing-key-only", allowRemote: true, dataDir: dir
  });
  try {
    assert.deepEqual(session.getActiveToolNames(), []);
    assert.ok(session.model);
    assert.equal(typeof session.prompt, "function");
    console.log("Real Pi session created without tools; no network model call");
  } finally { session.dispose(); }
} finally {
  await rm(dir, { recursive: true, force: true });
}
