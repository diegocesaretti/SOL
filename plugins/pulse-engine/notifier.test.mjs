import test from "node:test";
import assert from "node:assert/strict";
import {localClock,quietHour,messageFor,digestText,sendWhatsApp} from "./notifier.mjs";
test("quiet hours in Argentina",()=>{
 assert.equal(quietHour(new Date("2026-10-13T02:00:00Z")),true);
 assert.equal(quietHour(new Date("2026-10-12T17:00:00Z")),false);
 assert.equal(localClock(new Date("2026-10-12T17:00:00Z")).hour,14);
});
test("privacy-preserving notices and grouped digests",()=>{
 assert.match(messageFor({type:"order.cancelled",source:"mercadolibre"}),/cancelÃ³ una venta/);
 assert.match(digestText([{source:"mercadolibre"},{source:"mercadolibre"},{source:"finanzas"}]),/mercadolibre: 2/);
});
test("sendWhatsApp accepts only fixed loopback endpoint and configured destination",async()=>{
 const posts=[];
 const r=await sendWhatsApp({url:"http://127.0.0.1:3210/api/output/send",recipient:"5491100000000",text:"Prueba Sol Pulse",fetchImpl:async(url,o)=>{posts.push({url,payload:JSON.parse(o.body)});return {ok:true,json:async()=>({sent:true})};}});
 assert.equal(r.accepted,true);
 assert.equal(posts[0].payload.confirmedByUser,true);
 assert.equal(posts[0].payload.to,"5491100000000");
 await assert.rejects(()=>sendWhatsApp({url:"https://example.com/api/output/send",recipient:"5491100000000",text:"No"}),/invalid_nexo_local_url/);
 await assert.rejects(()=>sendWhatsApp({url:"http://127.0.0.1:3210/api/output/send",recipient:"000",text:"No"}),/invalid_recipient/);
});

