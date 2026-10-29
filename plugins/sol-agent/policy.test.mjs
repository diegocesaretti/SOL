import test from "node:test";
import assert from "node:assert/strict";
import { guidanceFor, normalizeProfile, proposalGate } from "./policy.mjs";
import { validateGoal } from "./autonomous.mjs";

const proposal={title:"Revisar temperatura",rationale:"Dos mediciones independientes coinciden",priority:"medium",confidence:.82,evidence:["kitchen_temp"]};
const at=new Date("2026-10-29T16:00:00.000Z");
const prior={type:"read_result",toolId:"kitchen_temp",cycle:0,hash:"stable",at:"2026-10-29T15:45:00.000Z"};
const current={type:"read_result",toolId:"kitchen_temp",cycle:1,hash:"stable",at:"2026-10-29T16:00:00.000Z"};

test("home playbook requires stable readings from two independent cycles",()=>{
 assert.equal(proposalGate({profile:"home",proposal,history:[current],now:at}).reason,"needs_second_observation");
 assert.equal(proposalGate({profile:"home",proposal,history:[prior,current],now:at}).accepted,true);
 assert.equal(proposalGate({profile:"home",proposal,history:[prior,{...current,hash:"changed"}],now:at}).reason,"needs_second_observation");
 assert.equal(proposalGate({profile:"home",proposal,history:[prior,{...current,cycle:0}],now:at}).reason,"needs_second_observation");
 assert.equal(proposalGate({profile:"home",proposal,history:[prior,{...current,at:"2026-10-29T15:45:40.000Z"}],now:at}).reason,"needs_second_observation");
});

test("business context permits grounded immediate recommendations but rejects low confidence",()=>{
 const evidence=[current];
 assert.equal(proposalGate({profile:"business",proposal,history:evidence,now:at}).accepted,true);
 assert.equal(proposalGate({profile:"business",proposal:{...proposal,confidence:.1},history:evidence,now:at}).reason,"low_confidence");
 assert.equal(proposalGate({profile:"business",proposal:{...proposal,evidence:["unknown"]},history:evidence,now:at}).reason,"unverified_source");
});

test("recent negative feedback suppresses a repeated noncritical recommendation",()=>{
 const feedback=[{at:at.toISOString(),rating:"irrelevant",proposalTitle:proposal.title}];
 assert.equal(proposalGate({profile:"business",proposal,history:[current],feedback,now:at}).reason,"recent_negative_feedback");
 assert.equal(proposalGate({profile:"business",proposal:{...proposal,priority:"high"},history:[current],feedback,now:at}).accepted,true);
});

test("profiles are opt-in and have distinct operating instructions",()=>{
 assert.equal(validateGoal({objective:"Monitor printers and inventory for disruptions."}).profile,"general");
 assert.equal(validateGoal({objective:"Monitor printers and inventory for disruptions.",profile:"business"}).profile,"business");
 assert.equal(normalizeProfile("home"),"home");
 assert.throws(()=>normalizeProfile("unsafe"),/invalid_goal_profile/);
 assert.match(guidanceFor("home"),/lecturas aisladas/);
 assert.match(guidanceFor("business"),/stock/);
});
