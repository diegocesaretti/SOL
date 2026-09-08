import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { renderPluginsPage } from "./plugins.js";

function harness() {
  const elements = new Map<string, any>();
  const pending: Array<{ path: string; options: any; resolve: (value: any) => void }> = [];
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: '', textContent: '', value: '', disabled: false, open: false, style: {},
      showModal() { this.open = true; }, close() { this.open = false; },
      addEventListener() {}, querySelectorAll() { return []; }, reportValidity() { return true; },
    });
    return elements.get(id);
  };
  const context: any = {
    document: { getElementById: get, querySelectorAll: () => [] },
    fetch: (path: string, options: any) => new Promise(resolve => pending.push({ path, options, resolve })),
    setInterval() {}, alert() {}, confirm: () => false,
  };
  const script = [...renderPluginsPage().matchAll(/<script>([\s\S]*?)<\/script>/g)][0]![1]!;
  runInNewContext(script, context);
  const reply = async (index: number, body: unknown, ok = true) => {
    pending[index]!.resolve({ ok, json: async () => body });
    await new Promise(resolve => setImmediate(resolve));
  };
  return { get, pending, context, reply };
}

test("plugin logs display actual newlines", async () => {
  const h = harness();
  const operation = h.context.showLogs('audio');
  await h.reply(1, { logs: ['one', 'two'].map(message => ({ at: 'now', level: 'info', stream: 'stdout', message })) });
  await operation;
  assert.equal(h.get('logs').textContent.split('\n').length, 2);
});

test("failed settings load cannot save an empty replacement", async () => {
  const h = harness();
  const operation = h.context.showSettings('audio');
  assert.equal(h.get('settings-save').disabled, true);
  await h.reply(1, { error: 'offline' }, false);
  await operation;
  await h.context.saveSettings();
  assert.equal(h.pending.length, 2);
});

test("late settings response cannot overwrite another plugin form", async () => {
  const h = harness();
  const first = h.context.showSettings('first');
  const second = h.context.showSettings('second');
  await h.reply(2, { definitions: [{ key: 'port', type: 'number', label: 'Second port' }], values: { port: 8766 } });
  await second;
  await h.reply(1, { definitions: [{ key: 'token', type: 'secret', label: 'First token' }], values: {} });
  await first;
  assert.match(h.get('settings-form').innerHTML, /Second port/);
  assert.doesNotMatch(h.get('settings-form').innerHTML, /First token/);
});

test("repo installation uses the reviewed repository even if input changes", async () => {
  const h = harness();
  h.get('add-dialog').open = true;
  h.get('repo').value = 'owner/reviewed';
  const preview = h.context.previewRepo();
  await h.reply(1, { preview: { repository: 'owner/reviewed', manifest: { name: 'Test', version: '1.0.0', permissions: [] } } });
  await preview;
  h.get('repo').value = 'owner/different';
  const install = h.context.installRepo();
  assert.equal(JSON.parse(h.pending[2]!.options.body).repository, 'owner/reviewed');
  await h.reply(2, { error: 'test' }, false);
  await install;
});
