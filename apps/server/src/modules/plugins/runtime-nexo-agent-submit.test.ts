import assert from "node:assert/strict";
import test from "node:test";
import { authorizeNexoAgentSubmit } from "./runtime-nexo-agent-submit.js";
import type { SolPluginRuntimePrincipal } from "./types.js";
import type { AuthPrincipal } from "../auth/session.js";

const nexo: SolPluginRuntimePrincipal = {
  pluginId: "nexo-whatsapp", memberId: "owner-id", householdId: "family-id",
  permissions: ["mcp.invoke.read","mcp.invoke.submit"]
};
const owner: AuthPrincipal = {
  memberId:"owner-id",householdId:"family-id",displayName:"Test",loginName:"owner",role:"owner"
};
const resolve = async () => owner;

test("accepts only Nexo's narrowly scoped mission state change tools",async()=>{
  for(const name of ["sol_agent_goal_create","sol_agent_goal_pause","sol_agent_goal_wake","sol_agent_feedback"]){
    await authorizeNexoAgentSubmit(nexo,{name,arguments:{id:"mission-one"}},resolve);
  }
  for(const name of ["sol_agent_proposals","home_assistant_call_service","bwa_3d_modify","sol_agent_execute","sol_agent_goal_delete"]){
    await assert.rejects(authorizeNexoAgentSubmit(nexo,{name,arguments:{}},resolve),/tool_forbidden/);
  }
});
test("no submit access for other plugins or missing approval",async()=>{
  await assert.rejects(authorizeNexoAgentSubmit({...nexo,pluginId:"sol-agent"},{name:"sol_agent_goal_create",arguments:{}},resolve),/plugin_forbidden/);
  await assert.rejects(authorizeNexoAgentSubmit({...nexo,permissions:["mcp.invoke.read"]},{name:"sol_agent_goal_create",arguments:{}},resolve),/permission_required/);
});
test("requires the active owner member and same membership",async()=>{
  const input={name:"sol_agent_goal_create",arguments:{objective:"Follow printer fleet availability daily"}};
  await assert.rejects(authorizeNexoAgentSubmit(nexo,input,async()=>({...owner,role:"adult"})),/owner_required/);
  await assert.rejects(authorizeNexoAgentSubmit(nexo,input,async()=>({...owner,memberId:"different"})),/owner_required/);
  await assert.rejects(authorizeNexoAgentSubmit(nexo,input,async()=>{throw new Error("plugin_member_not_found");}),/plugin_member_not_found/);
});
test("rejects malformed or oversized arguments before database access",async()=>{
 let called=false;
 const noDB=async()=>{called=true;return owner;};
 await assert.rejects(authorizeNexoAgentSubmit(nexo,{name:"sol_agent_goal_create",arguments:[]},noDB),/arguments_invalid/);
 await assert.rejects(authorizeNexoAgentSubmit(nexo,{name:"sol_agent_goal_create",arguments:{x:"x".repeat(3000)}},noDB),/arguments_invalid/);
 assert.equal(called,false);
});
