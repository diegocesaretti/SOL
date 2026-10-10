import assert from "node:assert/strict";
import { Script } from "node:vm";
import { test } from "node:test";
import { renderDailyPanoramaPage } from "./panorama-daily.js";
import { localClock, localInstant, timezoneOrDefault, validDate, selectBalanced, evidenceKey } from "../modules/panorama/daily.js";
import type { TimelineItem } from "../modules/life/timeline.js";

test("daily Panorama renders an accessible calendar and archived editions",()=>{
  const html=renderDailyPanoramaPage();
  assert.match(html,/El día, contado por SOL/);
  assert.match(html,/daily-days/);
  assert.match(html,/daily-narrative/);
  assert.match(html,/v1\/panorama\/digest\/day/);
  assert.match(html,/v1\/panorama\/digest\/calendar/);
  assert.match(html,/daily-editions/);
  const script=html.split("<script>")[1]?.split("</script>")[0];
  assert.ok(script,"Panorama exposes a browser script");
  assert.doesNotThrow(()=>new Script(script));
});
test("Buenos Aires daily schedule respects local midnight even near UTC rollover",()=>{
  const timezone="America/Argentina/Buenos_Aires";
  assert.deepEqual(localClock(new Date("2026-10-11T01:30:00Z"),timezone),{date:"2026-10-10",hour:22});
  assert.equal(localInstant("2026-10-10",0,timezone).toISOString(),"2026-10-10T03:00:00.000Z");
  assert.equal(localInstant("2026-10-10",24,timezone).toISOString(),"2026-10-11T03:00:00.000Z");
  assert.equal(timezoneOrDefault("invalid/nowhere"),timezone);
});
test("invalid days rejected and evidence balanced across providers",()=>{
  assert.equal(validDate("2026-02-30"),false);
  assert.equal(validDate("2026-10-10"),true);
  const whatsapp:Array<TimelineItem>=Array.from({length:25},(_,i)=>({
    id:String(i),type:"source",occurredAt:"2026-10-10T13:00:00.000Z",title:"Mensaje "+i,
    visibility:"private",provider:"whatsapp",
  }));
  const other:TimelineItem={id:"cal",type:"event",occurredAt:"2026-10-10T14:00:00.000Z",title:"Turno",visibility:"family",provider:"google_calendar"};
  assert.ok(selectBalanced([...whatsapp,other],4).some(x=>x.id==="cal"));
  assert.notEqual(evidenceKey({...other,title:"Turno modificado"}),evidenceKey(other));
});
