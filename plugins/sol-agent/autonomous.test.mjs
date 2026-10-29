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

test("human feedback remains durable and informs later reasoning", async()=>{
 const dir=await mkdtemp(join(tmpdir(),"sol-feedback-"));
 let current=new Date("2026-10-29T12:00:00Z");
 let cycles=0;
 try {
  const build=()=>createAutonomousRuntime({dataDir:dir,tools,now:()=>current,
    decide:async context=>{
      cycles++;
      if(cycles===1)return {action:"read",toolId:"printer_status",note:"Check current state"};
      if(cycles===2)return {action:"finish",note:"Review printer",proposal:{title:"Check printer",rationale:"Observed issue",priority:"medium",confidence:.8,evidence:["printer_status"]}};
      assert.equal(context.feedback[0].rating,"irrelevant");
      return {action:"wait",note:"Respect user feedback",waitMinutes:60};
    },
    invokeRead:async()=>({status:"warning"})
  });
  const first=build();await first.load();const g=await first.addGoal({objective});
  assert.equal((await first.cycle()).outcome,"finished");
  const p=first.listProposals()[0];
  await first.recordFeedback(g.id,p.id,"irrelevant","No issue");
  current=new Date("2026-10-29T13:01:00Z");
  const after=build();await after.load();
  assert.equal((await after.cycle()).outcome,"waiting");
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("home profile requires independent, stable checks across scheduled cycles",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"sol-agent-home-"));
 let instant=new Date("2026-10-29T15:00:00Z");
 const calls=[];
 try{
  const runner=createAutonomousRuntime({dataDir:dir,tools,now:()=>instant,
   decide:async context=>{
    calls.push(context);
    if (!context.observation) return {action:"read",toolId:"printer_status",note:"Verify latest state"};
    return {action:"finish",note:"Still abnormal",proposal:{title:"Inspect persistent fault",
      rationale:"The same status is confirmed",confidence:0.8,priority:"medium",evidence:["printer_status"]}};
   },
   invokeRead:async()=>({status:"unavailable"})
  });
  await runner.load();
  const g=await runner.addGoal({objective:"Inspect home devices for consistent unavailable states.",profile:"home",intervalMinutes:60});
  assert.equal((await runner.cycle()).outcome,"finished");
  assert.equal(runner.listProposals().length,0);
  assert.equal(runner.inspect().missions[0].filteredProposals,1);
  instant=new Date("2026-10-29T16:01:00Z");
  assert.equal((await runner.cycle()).outcome,"finished");
  assert.equal(runner.listProposals().length,1);
  assert.equal(runner.listProposals()[0].profile,"home");
  assert.equal(runner.listProposals()[0].attention,"quiet_digest");
  assert.equal(calls[0].profile,"home");
  assert.match(calls[0].guidance,/lecturas aisladas/);
  assert.equal(g.status,"ready");
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("business mission correlates evidence from separate SOL plugins without any write",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"sol-agent-business-"));
 const mixedTools=[
  {id:"seller",name:"bwa_3d_status",arguments:{},description:"Seller status"},
  {id:"production",name:"bambuddy_queue",arguments:{},description:"Production queue"}
 ];
 const invocations=[];
 try {
  const r=createAutonomousRuntime({dataDir:dir,tools:mixedTools,
   now:()=>new Date("2026-10-29T16:00:00Z"),
   decide:async context=>{
    if (!context.history.some(h=>h.type==="read_result")) return {action:"read",toolId:"seller",note:"Check seller"};
    if (!context.history.some(h=>h.type==="read_result" && h.toolId==="production"))
      return {action:"read",toolId:"production",note:"Check production"};
    return {action:"finish",note:"Manual review",proposal:{
     title:"Review workload",rationale:"Both sources require inspection",
     confidence:.85,priority:"medium",evidence:["seller","production"]
    }};
   },
   invokeRead:async name=>{invocations.push(name);return {status:"ok"};}
  });
  await r.load(); await r.addGoal({objective:"Correlate shop status and printer queue to find bottlenecks.",profile:"business"});
  assert.equal((await r.cycle()).outcome,"finished");
  assert.deepEqual(invocations,["bwa_3d_status","bambuddy_queue"]);
  assert.equal(r.listProposals().length,1);
  assert.deepEqual(r.listProposals()[0].evidence,["seller","production"]);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("event wakeups are durable, debounced, and never bypass paused missions",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"sol-agent-wakeup-"));
 let clock=new Date("2026-10-29T10:00:00Z");
 try {
  const make=()=>createAutonomousRuntime({dataDir:dir,tools,now:()=>clock,
   decide:async()=>({action:"wait",note:"No relevant changes",waitMinutes:60}),
   invokeRead:async()=>{throw Error("never read");}
  });
  const r=make();await r.load();const g=await r.addGoal({objective});
  assert.equal((await r.cycle()).outcome,"waiting");
  assert.equal((await r.cycle()).skipped,"nothing_due");
  const first=await r.wakeGoal(g.id,"Plugin event");
  assert.equal(first.queued,true);
  assert.equal((await r.wakeGoal(g.id,"Duplicate")).reason,"debounced");
  const restored=make();await restored.load();
  assert.equal((await restored.cycle()).outcome,"waiting");
  await restored.pauseGoal(g.id,true);
  clock=new Date("2026-10-29T10:10:00Z");
  assert.equal((await restored.wakeGoal(g.id,"Event while paused")).reason,"paused");
  assert.equal(restored.inspect().missions[0].paused,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
