import test from "node:test";
import assert from "node:assert/strict";
import {localClock,quietHour,urgentAllowed,messageFor,digestText,sendWhatsApp} from "./notifier.mjs";
const syntheticRecipient="5491100000000";
const token="t".repeat(40);
const endpoint="http://127.0.0.1:3210/api/automation/pulse/send";
test("quiet hours in Argentina",()=>{
 assert.equal(quietHour(new Date("2026-10-13T02:00:00Z")),true);
 assert.equal(quietHour(new Date("2026-10-12T17:00:00Z")),false);
 assert.equal(localClock(new Date("2026-10-12T17:00:00Z")).hour,14);
});
test("critical home alarms bypass quiet hours but routine events do not",()=>{
 const night=new Date("2026-10-13T02:00:00Z");
 assert.equal(urgentAllowed({type:"home.alarm.critical"},night),true);
 assert.equal(urgentAllowed({type:"invoice.deadline.today"},night),false);
});
test("privacy-preserving notices and grouped digests",()=>{
 assert.match(messageFor({type:"order.cancelled",source:"mercadolibre"}),/una venta de Mercado Libre/);
 assert.match(digestText([{source:"mercadolibre"},{source:"mercadolibre"},{source:"finanzas"}]),/mercadolibre: 2/);
});
test("Pulse sends using a scoped Nexo automation grant, never fake human confirmation",async()=>{
 const posts=[];
 const r=await sendWhatsApp({url:endpoint,recipient:syntheticRecipient,text:"SOL Pulse · Prueba autorizada",eventId:"event-123456",token,fetchImpl:async(url,o)=>{
   posts.push({url,headers:o.headers,payload:JSON.parse(o.body)});
   return {ok:true,json:async()=>({sent:true})};
 }});
 assert.equal(r.accepted,true);
 assert.equal(posts[0].headers.authorization,"Bearer "+token);
 assert.equal(posts[0].payload.automation,"sol_pulse");
 assert.equal(posts[0].payload.eventId,"event-123456");
 assert.equal(posts[0].payload.to,syntheticRecipient);
 assert.equal(posts[0].payload.confirmedByUser,undefined);
});
test("Pulse rejects invalid destinations, endpoints and missing standing grant",async()=>{
 const base={url:endpoint,recipient:syntheticRecipient,text:"SOL Pulse · Prueba",eventId:"event-123456",token};
 await assert.rejects(()=>sendWhatsApp({...base,url:"http://127.0.0.1:3210/api/output/send"}),/invalid_nexo_local_url/);
 await assert.rejects(()=>sendWhatsApp({...base,recipient:"000"}),/invalid_recipient/);
 await assert.rejects(()=>sendWhatsApp({...base,token:""}),/pulse_automation_token_missing/);
});
