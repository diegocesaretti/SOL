import { localClock } from "./notifier.mjs";

const DAY_MS=86400000;
const allowedStatuses=new Set(["detected","scheduled"]);
function dateDay(v) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(v||""))return null;
  const d=new Date(v+"T12:00:00Z");
  return Number.isNaN(d.valueOf())||d.toISOString().slice(0,10)!==v ? null : Math.floor(d.valueOf()/DAY_MS);
}
export function financeSignals(records,now=new Date(),ownerId="") {
  const today=localClock(now).day;
  const todayDay=dateDay(today);
  if(!ownerId||todayDay===null||!Array.isArray(records))return [];
  const signals=[];
  for(const r of records){
    if(!r?.id||!allowedStatuses.has(r.status))continue;
    const dueDay=dateDay(r.dueDate);
    if(dueDay===null)continue;
    const days=dueDay-todayDay;
    if(![2,1,0,-1].includes(days))continue;
    const key=days===2?"two_days":days===1?"tomorrow":days===0?"today":"overdue";
    const importance=days===2?55:days===1?72:days===0?84:91;
    signals.push({
      source:"finanzas",type:"invoice.deadline."+key,
      sourceEventId:String(r.id).slice(0,95)+":"+r.dueDate+":"+key,
      ownerId,privacy:"private",importance,
      occurredAt:now.toISOString(),
      title:"Vencimiento financiero "+key
    });
  }
  return signals;
}
export function createFinanceSource({sol,ingest,ownerId,enabled=false,intervalMs=3600000,now=()=>new Date()}){
  let timer=null,busy=false,running=false,lastPollAt=null,lastSuccessAt=null,lastError=null,lastCount=0,lastEmitted=0;
  async function tick(){
    if(!enabled||!ownerId||!sol?.enabled)return {skipped:"not_configured"};
    if(busy)return {skipped:"busy"};
    busy=true;lastPollAt=now().toISOString();
    try{
      const response=await sol.request("/v1/plugin-api/mcp/tools/invoke-read",{
        body:{name:"finanzas_vencimientos_list",arguments:{limit:200}}
      });
      if(!Array.isArray(response))throw new Error("finance_response_invalid");
      const signals=financeSignals(response,now(),ownerId);
      lastCount=response.length;lastEmitted=0;
      for(const signal of signals){const outcome=await ingest(signal);if(!outcome?.ok)throw new Error("finance_ingest_failed");if(!outcome.deduplicated)lastEmitted++;}
      lastSuccessAt=now().toISOString();lastError=null;
      return {ok:true,observed:lastCount,emitted:lastEmitted,potentiallyTruncated:lastCount>=200};
    } catch(error) {
      lastError=String(error?.message||error).slice(0,160);
      return {ok:false,error:lastError};
    }finally{busy=false;}
  }
  function start(){
    if(!enabled||!ownerId||!sol?.enabled||running)return false;
    running=true;
    const run=()=>void tick();
    timer=setInterval(run,Math.max(300000,intervalMs));timer.unref?.();run();
    return true;
  }
  function stop(){running=false;if(timer)clearInterval(timer);timer=null;}
  function status(){return {configured:!!(enabled&&ownerId&&sol?.enabled),running,lastPollAt,lastSuccessAt,lastError,lastCount,lastEmitted,intervalMs};}
  return {start,stop,tick,status};
}
