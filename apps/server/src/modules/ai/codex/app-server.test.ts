import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexAppServerClient } from "./app-server.js";
import { CodexProvider } from "./provider.js";

const fakeServer = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let ready = false;
function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    setTimeout(() => send({ id: msg.id, result: { userAgent: 'fake-codex' } }), 20);
    return;
  }
  if (msg.method === 'initialized') {
    ready = true;
    return;
  }
  if (!ready) {
    send({ id: msg.id, error: { code: -32002, message: 'Not initialized' } });
    return;
  }
  if (msg.method === 'account/read') {
    send({ id: msg.id, result: { account: { type: 'chatgpt', email: 'test@example.com', planType: 'plus' }, requiresOpenaiAuth: true } });
    return;
  }
  if (msg.method === 'account/rateLimits/read') {
    send({ id: msg.id, result: { rateLimits: { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 15, resetsAt: 2000000000 }, secondary: null, rateLimitReachedType: null } } });
    return;
  }
  if (msg.method === 'thread/start') {
    send({ id: msg.id, result: { thread: { id: 'thr_test', modelProvider: 'openai' } } });
    return;
  }
  if (msg.method === 'turn/start') {
    send({ id: msg.id, result: { turn: { id: 'turn_test', status: 'inProgress' } } });
    setTimeout(() => {
      send({ method: 'item/completed', params: { threadId: 'thr_test', turnId: 'turn_test', item: { type: 'agentMessage', id: 'msg_1', text: 'Hola desde Codex', phase: 'final_answer' } } });
      send({ method: 'turn/completed', params: { threadId: 'thr_test', turn: { id: 'turn_test', status: 'completed', items: [], error: null } } });
    }, 5);
    return;
  }
  if (msg.method === 'thread/archive' || msg.method === 'account/logout') {
    send({ id: msg.id, result: {} });
    return;
  }
  send({ id: msg.id, error: { code: -32601, message: 'not implemented in fake' } });
});
`;

async function withFakeCodex(
  callback: (client: CodexAppServerClient) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "sol-codex-test-"));
  await writeFile(join(directory, "app-server"), fakeServer, "utf8");
  const client = new CodexAppServerClient({
    command: process.execPath,
    cwd: directory,
    requestTimeoutMs: 2_000,
  });
  try {
    await callback(client);
  } finally {
    await client.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

test("Codex app-server serializes initialization across concurrent RPCs", async () => {
  await withFakeCodex(async (client) => {
    const [first, second] = await Promise.all([
      client.request<{ account: { type: string; planType: string } }>(
        "account/read",
        { refreshToken: false },
      ),
      client.request<{ account: { type: string; planType: string } }>(
        "account/read",
        { refreshToken: false },
      ),
    ]);
    assert.equal(first.account.type, "chatgpt");
    assert.equal(second.account.planType, "plus");
    assert.equal(client.ready, true);
  });
});

test("CodexProvider completes a restricted reasoning turn", async () => {
  await withFakeCodex(async (client) => {
    const provider = new CodexProvider(client);
    const result = await provider.reason({
      householdId: "household-test",
      memberId: "member-test",
      purpose: "conversation",
      instructions: "Presentate.",
      context: { household: "Test" },
    });

    assert.equal(result.provider, "codex");
    assert.equal(result.text, "Hola desde Codex");
    assert.equal(result.metadata?.threadId, "thr_test");
  });
});
