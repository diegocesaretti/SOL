import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNexoNotificationPublisher, localNexoUrl } from "./nexo-publisher.mjs";

const now=new Date("2026-10-29T15:00:00.000Z");
const finding={missionId:"fleet-watch",id:"123e4567-e89b-12d3-a456-426614174000",
  status:"review_only",priority:"high",confidence:.9,evidence:["fleet"],
  title:"Printer requires inspection",rationale:"The same fault was observed twice, verify manually",
  at:now.toISOString()};
test("Nexo endpoint must be loopback; never send bearer to remote",()=>{
 assert.equal(localNexoUrl("http://localhost:3210"),"http://localhost:3210");
 for(const url of ["https://api.whatsapp.com","http://remote.example:3210",
  "http://user:pass@localhost:3210","http://127.0.0.1:3210/redirect"]){
   assert.throws(()=>localNexoUrl(url),/nexo_url_must_be_loopback/);
 }
});
test("publisher cannot send when disabled or missing its separate secret",async()=>{
 let sends=0;
 const dir=await mkdtemp(join(tmpdir(),"sol-nexo-"));
 try{
  const one=createNexoNotificationPublisher({dataDir:dir,enabled:false,proposals:()=>[finding],
    fetcher:async()=>{sends++;throw Error("cannot call");}});
  await one.load();
  assert.equal((await one.publish()).skipped,"disabled");
  const two=createNexoNotificationPublisher({dataDir:dir,enabled:true,token:"short",proposals:()=>[finding],
    fetcher:async()=>{sends++;throw Error("cannot call");}});
  assert.equal((await two.publish()).skipped,"token_missing");
  assert.equal(sends,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("approved finding sends to Nexo once and preserves delivery checkpoint across restart",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"sol-nexo-"));let calls=0;
 const config={dataDir:dir,enabled:true,token:"a-long-fake-key-for-mock-testing",
   baseUrl:"http://127.0.0.1:3210",proposals:()=>[finding],now:()=>now,
   fetcher:async(url,req)=>{
     calls++;
     assert.equal(url,"http://127.0.0.1:3210/api/automation/sol-agent/notify");
     assert.equal(req.redirect,"error");
     assert.match(req.headers.authorization,/Bearer/);
     const body=JSON.parse(req.body);
     assert.equal("to" in body,false);
     assert.equal(body.missionId,"fleet-watch");
     return {ok:true,json:async()=>({sent:true})};
   }};
 try{
   const one=createNexoNotificationPublisher(config);
   await one.load();
   assert.equal((await one.publish()).sent,true);
   assert.equal((await one.publish()).skipped,"already_delivered");
   const two=createNexoNotificationPublisher(config);
   await two.load();
   assert.equal((await two.publish()).skipped,"already_delivered");
   assert.equal(calls,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("requires high-priority confidence and cites inspected evidence",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"sol-nexo-"));let calls=0;
 try{
  const p=createNexoNotificationPublisher({dataDir:dir,enabled:true,
    token:"another-long-fake-key-for-testing",now:()=>now,
    proposals:()=>[{...finding,priority:"low"}],
    fetcher:async()=>{calls++;throw Error("do not call");}});
  await p.load();
  assert.equal((await p.publish()).skipped,"no_high_priority_finding");
  assert.equal(calls,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
