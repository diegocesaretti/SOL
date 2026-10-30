import test from "node:test";
import assert from "node:assert/strict";
import { decideWithSolCodex, parseCodexDecision, validateSolCoreUrl } from "./codex-bridge.mjs";

const input = {
 apiUrl: "http://127.0.0.1:8787", pluginToken: "plugin-token-test",
 missionId:"printers-watch", objective:"Monitor printer fleet and suggest grounded reviews.",
 profile:"business", tools:[{id:"fleet",description:"Read printer status"}],
 history:[],feedback:[],steps:0,cycles:1
};
test("only localhost SOL Core is allowed to receive plugin credential",()=>{
 assert.equal(validateSolCoreUrl("http://127.0.0.1:8787"),"http://127.0.0.1:8787");
 assert.throws(()=>validateSolCoreUrl("https://sol.example.com"),/not_local/);
 assert.throws(()=>validateSolCoreUrl("http://evil.example.com"),/not_local/);
 assert.throws(()=>validateSolCoreUrl("http://user:pass@localhost:8787"),/not_local/);
 assert.throws(()=>validateSolCoreUrl("http://127.0.0.1:8787/redirect"),/not_local/);
});

test("SOL Agent invokes only Core ai/reason and validates Codex JSON response",async()=>{
 let called=0;
 const answer=await decideWithSolCodex({...input,
  fetcher:async (url,request)=>{
   called++;
   assert.equal(url,"http://127.0.0.1:8787/v1/plugin-api/ai/reason");
   assert.equal(request.method,"POST");
   assert.equal(request.redirect,"error");
   assert.equal(request.headers.authorization,"Bearer plugin-token-test");
   const body=JSON.parse(request.body);
   assert.equal(body.context.missionId,"printers-watch");
   assert.equal(body.context.objective,input.objective);
   assert.equal(body.context.profile,"business");
   assert.equal(Object.keys(body).length,1);
   return {ok:true,status:200,text:async()=>JSON.stringify({
      ok:true,provider:"codex",text:'{"action":"wait","note":"No findings","waitMinutes":60}'
   })};
  }
 });
 assert.equal(answer.action,"wait");
 assert.equal(called,1);
});

test("fails closed on other model providers and malformed decision",async()=>{
 assert.throws(()=>parseCodexDecision({ok:true,provider:"openai",text:'{"action":"wait"}'}),/provider_invalid/);
 assert.throws(()=>parseCodexDecision({ok:true,provider:"codex",text:"not json"}),/json_invalid/);
 assert.throws(()=>parseCodexDecision({ok:true,provider:"codex",text:"[]"}),/json_invalid/);
 await assert.rejects(decideWithSolCodex({...input,pluginToken:""}),/token_missing/);
 await assert.rejects(decideWithSolCodex({...input,
  fetcher:async()=>({ok:false,status:403,text:async()=>JSON.stringify({error:"plugin_permission_required"})})
 }),/sol_codex_http_403/);
});
