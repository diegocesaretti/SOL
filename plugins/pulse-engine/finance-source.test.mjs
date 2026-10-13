import test from "node:test";
import assert from "node:assert/strict";
import {financeSignals,createFinanceSource} from "./finance-source.mjs";
const date=new Date("2026-10-12T17:00:00Z");
const items=[
 {id:"f1",dueDate:"2026-10-14",status:"scheduled"},
 {id:"f2",dueDate:"2026-10-13",status:"detected"},
 {id:"f3",dueDate:"2026-10-12",status:"detected"},
 {id:"f4",dueDate:"2026-10-11",status:"scheduled"},
 {id:"f5",dueDate:"2026-10-15",status:"scheduled"},
 {id:"f6",dueDate:"2026-10-12",status:"paid"}
];
test("financial due date window includes only 2/1/0/-1 days and active records",()=>{
 const sigs=financeSignals(items,date,"owner");
 assert.equal(sigs.length,4);
 assert.deepEqual(sigs.map(x=>x.importance),[55,72,84,91]);
 assert.ok(sigs.every(x=>x.privacy==="private"&&!String(x.title).includes("f1")));
 assert.ok(sigs.every(x=>x.ownerId==="owner"));
 assert.equal(financeSignals([{id:"x",dueDate:"2026-13-88",status:"detected"}],date,"owner").length,0);
});
test("finance plugin read scope, repeat polls and error handling",async()=>{
 const seen=new Set();let emitted=0;
 const sol={enabled:true,request:async(path,payload)=>{
  assert.equal(path,"/v1/plugin-api/mcp/tools/invoke-read");
  assert.equal(payload.body.name,"finanzas_vencimientos_list");
  return items;
 }};
 const source=createFinanceSource({sol,ownerId:"owner",enabled:true,now:()=>date,ingest:async e=>{
  const key=e.sourceEventId;if(seen.has(key))return {ok:true,deduplicated:true};
  seen.add(key);emitted++;return {ok:true,deduplicated:false};
 }});
 assert.equal((await source.tick()).emitted,4);
 assert.equal((await source.tick()).emitted,0);
 assert.equal(emitted,4);
 assert.equal(source.status().lastError,null);
});
test("finance connector refuses unconfigured access",async()=>{
 const source=createFinanceSource({enabled:false,ownerId:"owner",sol:{enabled:true},ingest:async()=>{}});
 assert.deepEqual(await source.tick(),{skipped:"not_configured"});
 assert.equal(source.start(),false);
});
