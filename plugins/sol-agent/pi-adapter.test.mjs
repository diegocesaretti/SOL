import test from "node:test";
import assert from "node:assert/strict";
import { decideWithPi, piConfiguration } from "./pi-adapter.mjs";

function fakeSdk({ reply = '{"action":"wait","note":"No changes","waitMinutes":60}', noModel = false } = {}) {
  const state = { created: 0, loaded: 0, disposed: 0, calls: [] };
  const sdk = {
    createExtensionRuntime: () => ({}),
    SessionManager: { inMemory: dir => ({ kind: "memory", dir }) },
    SettingsManager: { inMemory: value => ({ kind: "settings", value }) },
    ModelRuntime: {
      create: async options => {
        state.loaded++; state.paths = options;
        return {
          setRuntimeApiKey: async (...args) => {state.apiKey = args;},
          getModel: (...args) => noModel ? null : { provider: args[0], id: args[1] }
        };
      }
    },
    createAgentSession: async options => {
      state.created++; state.options = options;
      return { session: {
        prompt: async text => {state.calls.push(text);},
        getLastAssistantText: () => reply,
        getActiveToolNames: () => [],
        dispose: () => {state.disposed++;}
      }};
    }
  };
  return {sdk,state};
}
const config = {
  provider:"openai",modelId:"gpt-4.1",apiKey:"test-fake-key",
  allowRemote:true,dataDir:"/tmp/sol-agent-test",
  objective:"Analyze printer issues without acting",
  tools:[{id:"fleet",description:"Read fleet state"}],
  observation:{id:"fleet",result:'{"status":"idle"}'},
  history:[],feedback:[],profile:"business",guidance:"read only",steps:1,cycles:0
};

test("Pi engine is opt-in, and invalid config cannot load the SDK", async () => {
  assert.throws(() => piConfiguration({...config,allowRemote:false}),/explicit_opt_in/);
  assert.throws(() => piConfiguration({...config,provider:"unknown"}),/provider_not_allowlisted/);
  let called=0;
  await assert.rejects(
    decideWithPi({...config,allowRemote:false,sdkLoader:async()=>{called++;throw Error("bad");}}),
    /explicit_opt_in/
  );
  assert.equal(called,0);
});

test("Pi SDK session disables ALL tools, extensions and file-backed sessions", async()=>{
  const {sdk,state}=fakeSdk();
  const result=await decideWithPi({...config,sdkLoader:async()=>sdk});
  assert.equal(result.action,"wait");
  assert.equal(state.options.noTools,"all");
  assert.deepEqual(state.options.tools,[]);
  assert.deepEqual(state.options.customTools,[]);
  assert.equal(state.options.sessionManager.kind,"memory");
  assert.deepEqual(state.options.resourceLoader.getSkills().skills,[]);
  assert.deepEqual(state.options.resourceLoader.getExtensions().extensions,[]);
  assert.equal(state.options.resourceLoader.getSystemPrompt().includes("NO ejecutás herramientas"),true);
  assert.equal(state.apiKey[0],"openai");
  assert.equal(state.calls.length,1);
  assert.match(state.calls[0],/printer issues/);
  assert.equal(state.disposed,1);
});

test("Pi adapter fails closed on malformed JSON and missing models", async()=>{
 const bad=fakeSdk({reply:"not-json"});
 await assert.rejects(decideWithPi({...config,sdkLoader:async()=>bad.sdk}),/JSON/);
 assert.equal(bad.state.disposed,1);
 const missing=fakeSdk({noModel:true});
 await assert.rejects(decideWithPi({...config,sdkLoader:async()=>missing.sdk}),/model_unavailable/);
 assert.equal(missing.state.created,0);
});
