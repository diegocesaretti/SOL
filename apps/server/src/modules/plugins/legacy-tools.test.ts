import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { PluginToolRuntime } from "./tool-runtime.js";
import type { PluginManager } from "./manager.js";
import { legacyInputSchema, validateLegacyRegistration } from "./legacy-tools.js";

const principal = { pluginId: 'home-assistant', householdId: 'house', memberId: 'owner', permissions: ['mcp.register'] };
const registration = (callbackUrl: string) => ({ callbackUrl, tools: [{
  name: 'home_assistant_control', description: 'Control a device', requiredScope: 'actions',
  inputSchema: { type: 'object', properties: { entity: { type: 'string' }, data: { type: 'object', additionalProperties: true } }, required: ['entity'], additionalProperties: false },
}] });

test('legacy callbacks reject remote URLs, reserved names and unknown scopes', () => {
  assert.throws(() => validateLegacyRegistration(registration('http://example.com/call')), /loopback/);
  const bad = registration('http://127.0.0.1:9999/call');
  bad.tools[0]!.name = 'sol_status';
  assert.throws(() => validateLegacyRegistration(bad), /reserved/);
  bad.tools[0]!.name = 'home_assistant_control';
  bad.tools[0]!.requiredScope = 'unknown';
  assert.throws(() => validateLegacyRegistration(bad), /scope/);
});

test('audio callback names and requiresSubmit preserve explicit confirmation', () => {
  const result = validateLegacyRegistration({ callbackUrl: 'http://127.0.0.1:8766/ws/_sol/test', tools: [{
    name: 'codex_audio_end_session', description: 'End the voice session', requiresSubmit: true,
    inputSchema: { type: 'object', properties: { confirmedByUser: { type: 'boolean', const: true } }, required: ['confirmedByUser'], additionalProperties: false },
  }] });
  assert.equal(result.tools[0]!.name, 'codex_audio_end_session');
  assert.equal(result.tools[0]!.requiresSubmit, true);
  const schema = legacyInputSchema(result.tools[0]!.inputSchema!);
  assert.throws(() => schema.parse({ confirmedByUser: false }));
  assert.throws(() => schema.parse({}));
  assert.deepEqual(schema.parse({ confirmedByUser: true }), { confirmedByUser: true });
});

test('legacy tools retain schema, action checks, scope and token revocation through SOL', async () => {
  let live = true;
  let permissions = ['mcp.register'];
  let received: any;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = { path: request.url, body: JSON.parse(Buffer.concat(chunks).toString()), token: request.headers.authorization };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const manager = {
    async get() { return { state: 'running', enabled: true, approvedPermissions: permissions }; },
    async authenticateRuntimeToken() { return live ? principal : null; },
  } as unknown as PluginManager;
  const runtime = new PluginToolRuntime(manager);
  try {
    const tools = await runtime.register(principal, 'test-token', registration(`http://127.0.0.1:${address.port}/api/mcp/call`), true);
    assert.equal(tools[0]!.inputSchema?.type, 'object');
    assert.equal((await runtime.list(principal, false)).length, 0);
    assert.equal((await runtime.list({ ...principal, memberId: 'other' }, true)).length, 0);
    await assert.rejects(runtime.execute(principal, false, tools[0]!.name, { entity: 'light.test' }), /scope/);
    await assert.rejects(runtime.execute(principal, true, tools[0]!.name, { entity: 10 }));
    assert.deepEqual(await runtime.execute(principal, true, tools[0]!.name, { entity: 'light.test', data: { brightness: 12 } }), { ok: true });
    assert.equal(received.path, '/api/mcp/call');
    assert.equal(received.body.type, 'sol.plugin.mcp.invoke');
    assert.equal(received.body.arguments.data.brightness, 12);
    assert.equal(received.token, 'Bearer test-token');
    permissions = [];
    await assert.rejects(runtime.execute(principal, true, tools[0]!.name, { entity: 'light.test' }), /permission/);
    live = false;
    assert.equal((await runtime.list(principal, true)).length, 0);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
