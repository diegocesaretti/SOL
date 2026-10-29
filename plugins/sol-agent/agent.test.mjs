import test from "node:test";
import assert from "node:assert/strict";
import { parseSources, observe, makeProposal } from "./core.mjs";
import { localEndpoint, inferLocally } from "./model.mjs";

const source = [{ id: "printer", name: "bambuddy_status", arguments: {} }];
const initial = { version: 1, snapshots: {}, proposals: [] };

test("only explicit, well-formed sources are accepted", () => {
  assert.equal(parseSources(JSON.stringify(source)).length, 1);
  assert.deepEqual(parseSources("[]"), []);
  assert.throws(() => parseSources("{"), /sources_invalid_json/);
  assert.throws(() => parseSources('[{"id":"a!","name":"x"}]'), /source_invalid_id/);
  assert.throws(() => parseSources(JSON.stringify([source[0], source[0]])), /source_invalid_id/);
});

test("first observation baselines without generating retrospective alerts", async () => {
  let inferCalls = 0;
  const first = await observe({ state: initial, sources: source,
    invokeRead: async () => ({ state: "idle" }), infer: async () => { inferCalls++; return {}; } });
  assert.equal(first.baselined, 1);
  assert.equal(first.changes, 0);
  assert.equal(first.state.proposals.length, 0);
  assert.equal(inferCalls, 0);
});

test("only changed data triggers local reasoning and yields a proposal", async () => {
  const first = await observe({ state: initial, sources: source, invokeRead: async () => ({ state: "idle" }) });
  const second = await observe({ state: first.state, sources: source,
    invokeRead: async () => ({ state: "failed" }),
    infer: async ({ changes }) => ({ proposals: [{ title: "Revisar impresora", rationale: "El estado cambió", priority: "medium", confidence: .8, evidence: [changes[0].id], action: "start_print" }] }) });
  assert.equal(second.changes, 1);
  assert.equal(second.state.proposals.length, 1);
  assert.equal("action" in second.state.proposals[0], false);
  const third = await observe({ state: second.state, sources: source,
    invokeRead: async () => ({ state: "failed" }), infer: async () => { throw Error("should not run"); } });
  assert.equal(third.changes, 0);
});

test("disabled model retains changed checkpoint for later analysis", async () => {
  const first = await observe({ state: initial, sources: source, invokeRead: async () => 1 });
  const second = await observe({ state: first.state, sources: source, invokeRead: async () => 2, infer: null });
  assert.equal(second.skipped, "model_disabled");
  assert.deepEqual(second.state.snapshots, first.state.snapshots);
});

test("model failures do not advance changed source checkpoints", async () => {
  const first = await observe({ state: initial, sources: source, invokeRead: async () => 1 });
  await assert.rejects(observe({ state: first.state, sources: source, invokeRead: async () => 2,
    infer: async () => { throw Error("offline"); } }), /offline/);
  assert.equal(first.state.proposals.length, 0);
});

test("read failures do not create phantom proposals", async () => {
  const result = await observe({ state: initial, sources: source,
    invokeRead: async () => { throw Error("not permitted"); }, infer: async () => ({ proposals: [] }) });
  assert.equal(result.errors.length, 1);
  assert.equal(result.state.proposals.length, 0);
});

test("model output must cite observed source IDs", () => {
  const now = new Date().toISOString();
  assert.equal(makeProposal({ title: "X", rationale: "Y", priority: "high", evidence: ["unknown"] }, ["printer"], now), null);
  assert.equal(makeProposal({ title: "X", rationale: "Y", priority: "urgent", evidence: ["printer"] }, ["printer"], now), null);
});

test("remote model endpoints are blocked", () => {
  assert.equal(localEndpoint("http://127.0.0.1:11434/v1/chat/completions"), "http://127.0.0.1:11434/v1/chat/completions");
  assert.throws(() => localEndpoint("https://api.openai.com/v1/chat/completions"), /must_be_local/);
  assert.throws(() => localEndpoint("http://localhost:11434/evil"), /unsupported_model_endpoint/);
});

test("local model adapter parses JSON without executing actions", async () => {
  const data = await inferLocally({ endpoint: "http://localhost:11434/v1/chat/completions",
    model: "test-model", objectives: "suggest only", changes: [{ id: "printer", sample: "failed" }], history: [],
    fetcher: async (_url, opts) => {
      const request = JSON.parse(opts.body);
      assert.equal(request.messages[0].role, "system");
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"proposals":[]}' } }] }) };
    } });
  assert.deepEqual(data, { proposals: [] });
});
