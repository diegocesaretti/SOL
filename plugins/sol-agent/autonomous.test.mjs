import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutonomousRuntime, validateCatalog, validateDecision, validateGoal } from "./autonomous.mjs";

const tools = [{id:"printer_status",name:"bambuddy_fleet_status",description:"Printer state",arguments:{}}];
const objective = "Investigate printer availability and suggest useful improvements.";

test("mission and catalog are validated", () => {
 assert.equal(validateCatalog(tools).length,1);
 assert.equal(validateGoal({objective}).intervalMinutes,60);
 assert.throws(()=>validateDecision({action:"read",toolId:"other"},tools),/tool_not_allowed/);
 assert.throws(()=>validateDecision({action:"write",toolId:"printer_status"},tools),/invalid_decision_action/);
});
test("persistent mission can investigate and resume after restart", async()=>{
 const dir=await mkdtemp(join(tmpdir(),"sol-agent-"));
 try {
   let calls=0;
   const now=()=>new Date("2026-10-29T16:00:00Z");
   const runtime=createAutonomousRuntime({dataDir:dir,tools,now,
     decide:async context=>{
       calls++;
       if(calls===1)return {action:"read",toolId:"printer_status",note:"Check"};
       assert.ok(context.observation);
       return {action:"finish",note:"Finished",proposal:{
         title:"Inspect printer",rationale:"Printer reported a fault",priority:"medium",confidence:.8,evidence:["printer_status"]
       }};
     },
     invokeRead:async()=>({status:"error",privatePayload:"sensitive-value"})
   });
   await runtime.load();
   await runtime.addGoal({objective});
   assert.equal((await runtime.cycle()).outcome,"finished");
   assert.equal(runtime.listProposals().length,1);
   const onDisk=await readFile(join(dir,"sol-agent-missions.json"),"utf8");
   assert.equal(onDisk.includes("sensitive-value"),false);
   const again=createAutonomousRuntime({dataDir:dir,tools,now,
     decide:async()=>{throw Error("should not run");},
     invokeRead:async()=>{throw Error("should not read");}
   });
   await again.load();
   assert.equal(again.listProposals().length,1);
   assert.equal((await again.cycle()).skipped,"nothing_due");
 }finally{await rm(dir,{recursive:true,force:true});}
});
