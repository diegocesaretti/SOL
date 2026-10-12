import test from "node:test";
import assert from "node:assert/strict";
import {normalize,classify,ingest,listEvents} from "./index.mjs";
test("validates event identity",()=>{
 assert.throws(()=>normalize({source:"other",type:"sale.created",sourceEventId:"1"}),/invalid_event_fields/);
 assert.equal(normalize({source:"mercadolibre",type:"sale.created",sourceEventId:"1",ownerId:"test"}).source,"mercadolibre");
});
test("keeps private titles redacted and deduplicates",async()=>{
 const e={source:"mercadolibre",type:"order.created",sourceEventId:"test-"+Date.now(),ownerId:"test",title:"PRIVATE order",privacy:"private"};
 const a=await ingest(e),b=await ingest(e);
 assert.equal(a.deduplicated,false);assert.equal(b.deduplicated,true);
 assert.equal(a.event.title,"[restringido]");
 assert.equal(listEvents({limit:1}).events[0].id,a.event.id);
});
test("classifies significant changes",()=>{
 assert.equal(classify({type:"printer.failure"}).decision,"review");
 assert.equal(classify({type:"device.heartbeat"}).decision,"ignore");
 assert.equal(classify({type:"message.received"}).decision,"digest");
});
