import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {allowlist,stateSignal,createHomeSource} from "./home-source.mjs";
const current=new Date("2026-10-12T17:30:00Z");
test("explicit allowlist excludes location and personal tracking",()=>{
 assert.deepEqual(allowlist("climate.aire_cocina,person.diego,device_tracker.phone,binary_sensor.smoke_alarm,climate.aire_cocina"),["climate.aire_cocina","binary_sensor.smoke_alarm"]);
});
test("home alarm becomes urgent while climate transitions are recorded quietly",()=>{
 const old={entityId:"binary_sensor.smoke_alarm",state:"off",lastChanged:"2026-10-12T16:00:00Z"};
 const next={...old,state:"on",lastChanged:"2026-10-12T17:00:00Z"};
 assert.equal(stateSignal(old,next,"owner").importance,98);
 assert.equal(stateSignal(old,next,"owner").type,"home.alarm.critical");
 assert.equal(stateSignal(old,old,"owner"),null);
 assert.equal(stateSignal({entityId:"climate.aire_cocina",state:"off"},{entityId:"climate.aire_cocina",state:"heat",lastChanged:"2026-10-12T17:00:00Z"},"owner").importance,18);
});
test("home state baseline, changes, duplicate prevention",async()=>{
 const dataDir=await mkdtemp(join(tmpdir(),"pulse-home-test-"));
 const states={"climate.aire_cocina":{entityId:"climate.aire_cocina",state:"off",lastChanged:"2026-10-12T16:00:00Z"}};
 const events=[];
 const sol={enabled:true,request:async(path,body)=>{
  assert.equal(path,"/v1/plugin-api/mcp/tools/invoke-read");
  assert.equal(body.body.name,"home_assistant_get_state");
  return {...states[body.body.arguments.entityId]};
 }};
 const source=createHomeSource({sol,ingest:async e=>{events.push(e);return {ok:true,deduplicated:false};},dataDir,ownerId:"owner",enabled:true,entityIds:["climate.aire_cocina"],now:()=>current});
 try{
  assert.equal((await source.tick()).baselined,true);assert.equal(events.length,0);
  states["climate.aire_cocina"]={entityId:"climate.aire_cocina",state:"heat",lastChanged:"2026-10-12T17:15:00Z"};
  assert.equal((await source.tick()).emitted,1);
  assert.equal((await source.tick()).emitted,0);
  assert.equal(events[0].source,"home_assistant");
 }finally{await rm(dataDir,{recursive:true,force:true});}
});
