import test from "node:test";
import assert from "node:assert/strict";
import {localClock,quietHour,urgentAllowed,messageFor,digestText,sendWhatsApp} from "./notifier.mjs";
const syntheticRecipient="5491100000000";
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
test("sendWhatsApp accepts only fixed loopback endpoint and configured destination",async()=>{
 const posts=[];
 const r=await sendWhatsApp({url:"http://127.0.0.1:3210/api/output/send",recipient:syntheticRecipient,text:"Pulse test",fetchImpl:async(url,o)=>{posts.push({url,payload:JSON.parse(o.body)});return {ok:true,json:async()=>({sent:true})};}});
 assert.equal(r.accepted,true);
 assert.equal(posts[0].payload.confirmedByUser,true);
 assert.equal(posts[0].payload.to,syntheticRecipient);
 await assert.rejects(()=>sendWhatsApp({url:"https://example.com/api/output/send",recipient:syntheticRecipient,text:"No"}),/invalid_nexo_local_url/);
 await assert.rejects(()=>sendWhatsApp({url:"http://127.0.0.1:3210/api/output/send",recipient:"000",text:"No"}),/invalid_recipient/);
});
