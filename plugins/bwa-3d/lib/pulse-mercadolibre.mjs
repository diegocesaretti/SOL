import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const maxOrders = 100;
const pollIntervalDefault = 180000;
const iso = () => new Date().toISOString();
export function snapshots(orders) {
  const array = Array.isArray(orders) ? orders : Array.isArray(orders?.results) ? orders.results : null;
  if (!array) throw new Error("invalid_mercadolibre_orders_response");
  return array.slice(0,maxOrders).map((order)=>{
    const id=String(order?.id||"");
    if(!/^\d{5,22}$/.test(id)) throw new Error("invalid_mercadolibre_order_id");
    return {id,status:String(order.status||"unknown").toLowerCase(),updatedAt:order.date_last_updated||order.date_created||null};
  });
}
export function transitions(previous, latest) {
  const result=[];
  for(const order of latest){
    const prior=previous[order.id];
    if(!prior)result.push({type:"order.created",order,importance:64,revision:"created"});
    else if(prior.status!==order.status)result.push({
      type:order.status==="cancelled"?"order.cancelled":"order.status.changed",
      order,importance:order.status==="cancelled"?82:66,revision:"status:"+order.status+":"+String(order.updatedAt||"")
    });
  }
  return result;
}
async function loadStore(path) {
  try {const data=JSON.parse(await readFile(path,"utf8"));return data?.version===1&&typeof data.orders==="object"&&data.orders ? data : null;}
  catch(e){if(e?.code==="ENOENT")return null;throw e;}
}
async function saveStore(path,data){
  await mkdir(join(path,".."),{recursive:true});
  const temp=path+"."+randomUUID()+".tmp";
  await writeFile(temp,JSON.stringify(data),"utf8");
  await rename(temp,path);
}
export function createMercadoLibrePulsePoller({listOrders,dataDir,endpoint,token,ownerId,intervalMs=pollIntervalDefault,fetchImpl=fetch}){
  const configured=typeof token==="string"&&token.length>=32&&/^http:\/\/127\.0\.0\.1:\d+\/v1\/ingest$/.test(endpoint||"")&&Boolean(ownerId);
  const path=join(dataDir,"pulse-ml-checkpoint.json");
  let running=false,timer=null,busy=false,lastPollAt=null,lastSuccessAt=null,lastError=null,baselineInitialized=false,lastCount=0;
  async function publish(signal){
    const body={
      source:"mercadolibre",type:signal.type,
      sourceEventId:signal.order.id+":"+signal.revision,
      ownerId,title:"Mercado Libre: "+signal.type,
      privacy:"private",importance:signal.importance,
      occurredAt:signal.order.updatedAt||iso()
    };
    const res=await fetchImpl(endpoint,{
      method:"POST",
      headers:{"authorization":"Bearer "+token,"content-type":"application/json"},
      body:JSON.stringify(body),
      signal:AbortSignal.timeout(10000)
    });
    if(!res.ok)throw new Error("pulse_ingest_http_"+res.status);
    const outcome=await res.json();
    if(outcome?.ok!==true)throw new Error("pulse_ingest_failed");
    return outcome;
  }
  async function tick(){
    if(!configured)throw new Error("pulse_publisher_not_configured");
    if(busy)return {skipped:true};
    busy=true;lastPollAt=iso();
    try {
      const response=await listOrders({limit:maxOrders,sort:"date_desc"});
      const latest=snapshots(response);
      lastCount=latest.length;
      const prior=await loadStore(path);
      const existing=prior?.orders||{};
      baselineInitialized=Boolean(prior);
      if(!prior){
        const initial=Object.fromEntries(latest.map(x=>[x.id,x]));
        await saveStore(path,{version:1,orders:initial,lastSuccessAt:iso()});
        baselineInitialized=true;lastSuccessAt=iso();lastError=null;
        return {baselined:true,observed:latest.length,emitted:0};
      }
      const changes=transitions(existing,latest);
      let emitted=0;
      for(const signal of changes){await publish(signal);emitted++;}
      const merged={...existing,...Object.fromEntries(latest.map(x=>[x.id,x]))};
      const keys=Object.keys(merged);
      if(keys.length>2000){for(const k of keys.slice(0,keys.length-2000))delete merged[k];}
      await saveStore(path,{version:1,orders:merged,lastSuccessAt:iso()});
      lastSuccessAt=iso();lastError=null;
      return {baselined:false,observed:latest.length,emitted,potentiallyTruncated:latest.length===maxOrders};
    }catch(e){lastError=String(e?.message||e).slice(0,150);throw e;}
    finally {busy=false;}
  }
  function start(){
    if(!configured||running)return false;
    running=true;
    const run=()=>void tick().catch(e=>console.warn("Pulse ML publisher: "+String(e?.message||e)));
    timer=setInterval(run,Math.max(30000,intervalMs));timer.unref?.();run();
    return true;
  }
  function stop(){running=false;if(timer)clearInterval(timer);timer=null;}
  function status(){return {configured,running,baselineInitialized,lastPollAt,lastSuccessAt,lastError,lastCount,intervalMs};}
  return {start,stop,tick,status};
}
