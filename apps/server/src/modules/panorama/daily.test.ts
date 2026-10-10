import assert from "node:assert/strict";
import { test } from "node:test";
import { collectDayEvidence, evidenceKey, mergeSourceCounts, selectBalanced } from "./daily.js";
import type { AuthPrincipal } from "../auth/session.js";
import type { TimelineItem, TimelineCursor } from "../life/timeline.js";

const principal: AuthPrincipal = {
  householdId: "00000000-0000-0000-0000-000000000001",
  memberId: "00000000-0000-0000-0000-000000000002",
  displayName: "Test", loginName: "test", role: "owner",
};
test("cursor-based scan reads beyond 500 with 1201 identical timestamps", async () => {
  const time="2026-10-10T13:00:00.000Z";
  const events:TimelineItem[] = Array.from({length:1201},(_,i)=>({
    id:String(2000-i).padStart(6,"0"),type:"source",occurredAt:time,
    title:"Evento "+i,visibility:"private",provider:"whatsapp",
  }));
  const seen:TimelineCursor[]=[];
  const fetched=await collectDayEvidence(principal,new Date("2026-10-10T02:59:59Z"),new Date("2026-10-11T03:00:01Z"),
    async (_principal,options={})=>{
      const at=options.cursor?events.findIndex(item=>item.id===options.cursor?.id)+1:0;
      const take=options.limit||500;
      const items=events.slice(at,at+take);
      if(options.cursor)seen.push(options.cursor);
      const last=items.length===take?items[items.length-1]:undefined;
      const nextCursor=last?{occurredAt:last.occurredAt,type:last.type,id:last.id}:undefined;
      return {items,nextCursor,nextBefore:nextCursor?.occurredAt};
    },
  );
  assert.equal(fetched.items.length,1201);
  assert.equal(new Set(fetched.items.map(x=>x.id)).size,1201);
  assert.equal(fetched.pages,3);
  assert.equal(fetched.truncated,false);
  assert.deepEqual(seen.map(c=>c.id),[events[499]?.id,events[999]?.id]);
});

test("incremental fingerprints preserve prior source totals, without recounting overlap",()=>{
  const whatsapp:TimelineItem={
    id:"a",type:"source",occurredAt:"2026-10-10T12:00:00Z",
    title:"Cambio de horario",visibility:"private",provider:"whatsapp",
  };
  const changed={...whatsapp,title:"Cambio de horario confirmado"};
  assert.notEqual(evidenceKey(whatsapp),evidenceKey(changed));
  const google:TimelineItem={...whatsapp,id:"b",provider:"gmail",title:"Factura"};
  assert.deepEqual(mergeSourceCounts({"WhatsApp":500},[changed,google]),{"WhatsApp":501,"Gmail":1});
  assert.ok(selectBalanced([...Array(80).fill(whatsapp),google],3).some(x=>x.provider==="gmail"));
});
