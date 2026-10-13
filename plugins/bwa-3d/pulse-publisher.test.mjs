import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMercadoLibrePulsePoller, snapshots, transitions } from "./lib/pulse-mercadolibre.mjs";

const order=(id,status="paid",updatedAt="2026-10-12T12:00:00Z")=>({id,status,date_last_updated:updatedAt});
test("normalization and transitions detect creation and cancellation",()=>{
 const first=snapshots({results:[order(123456)]});
 assert.equal(first.length,1);
 assert.equal(transitions({},first)[0].type,"order.created");
 assert.equal(transitions({"123456":first[0]},first).length,0);
 assert.equal(transitions({"123456":first[0]},snapshots({results:[order(123456,"cancelled")]}))[0].importance,82);
 assert.throws(()=>snapshots({foo:1}),/invalid_mercadolibre_orders_response/);
});
test("baseline suppresses old orders, new orders dedupe, cancellation raises review",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"pulse-ml-test-"));
 let orders={results:[order(123456)]};
 const emitted=[];
 const poller=createMercadoLibrePulsePoller({
   dataDir:dir,endpoint:"http://127.0.0.1:8794/v1/ingest",token:"a".repeat(40),ownerId:"owner",
   listOrders:async()=>orders,
   fetchImpl:async(_url,opts)=>{emitted.push(JSON.parse(opts.body));return {ok:true,json:async()=>({ok:true})};}
 });
 try{
   const first=await poller.tick();assert.equal(first.baselined,true);assert.equal(emitted.length,0);
   orders={results:[order(234567),order(123456)]};
   assert.equal((await poller.tick()).emitted,1);
   assert.equal(emitted[0].type,"order.created");
   assert.equal(emitted[0].ownerId,"owner");
   assert.equal((await poller.tick()).emitted,0);
   orders={results:[order(234567,"cancelled","2026-10-12T14:00:00Z"),order(123456)]};
   assert.equal((await poller.tick()).emitted,1);
   assert.equal(emitted[1].type,"order.cancelled");
   assert.equal(emitted[1].importance,82);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("failed ingestion does not advance checkpoint; subsequent retry sends once",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"pulse-ml-retry-"));
 let orders={results:[order(123456)]},fail=true,posts=0;
 const poller=createMercadoLibrePulsePoller({
   dataDir:dir,endpoint:"http://127.0.0.1:8794/v1/ingest",token:"b".repeat(40),ownerId:"owner",
   listOrders:async()=>orders,
   fetchImpl:async()=>{posts++;return fail?{ok:false,status:503}:{ok:true,json:async()=>({ok:true})};}
 });
 try{
   await poller.tick();orders={results:[order(234567),order(123456)]};
   await assert.rejects(()=>poller.tick(),/pulse_ingest_http_503/);
   fail=false;assert.equal((await poller.tick()).emitted,1);
   assert.equal(posts,2);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("publisher remains off without explicit credentials",()=>{
 const p=createMercadoLibrePulsePoller({dataDir:"C:\\scratch",listOrders:async()=>({results:[]}),ownerId:"owner",token:"",endpoint:"http://127.0.0.1:8794/v1/ingest"});
 assert.equal(p.status().configured,false);
 assert.equal(p.start(),false);
});
