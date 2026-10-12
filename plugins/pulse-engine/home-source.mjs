import { mkdir,readFile,writeFile,rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {join} from "node:path";

const VALID=/^(climate|switch|light|sensor|binary_sensor)\.[a-z0-9_]{2,90}$/;
const DANGER=/\b(smoke|fire|flood|water_leak|gas_leak|carbon_monoxide)\b/;
export function allowlist(value) {
  return [...new Set(String(value||"").split(",").map(x=>x.trim().toLowerCase()).filter(x=>VALID.test(x)))].slice(0,20);
}
export function stateSignal(before,after,ownerId) {
  if(!before||!after||before.entityId!==after.entityId||before.state===after.state)return null;
  if(!VALID.test(after.entityId))return null;
  const critical=after.entityId.startsWith("binary_sensor.")&&after.state==="on"&&DANGER.test(after.entityId.replaceAll("_"," "));
  const stamp=after.lastChanged||new Date().toISOString();
  return {
    source:"home_assistant",type:critical?"home.alarm.critical":"home.state.changed",
    sourceEventId:after.entityId+":"+after.state+":"+stamp,
    ownerId,occurredAt:stamp,privacy:"private",
    title:critical?"Alarma del hogar":"Cambio de estado doméstico",
    importance:critical?98:18
  };
}
async function readCheckpoint(path) {
  try{const parsed=JSON.parse(await readFile(path,"utf8"));return parsed?.version===1?parsed:null;}
  catch(e){if(e?.code==="ENOENT")return null;throw e;}
}
async function persist(path,checkpoint) {
  const temp=path+"."+randomUUID()+".tmp";
  await mkdir(join(path,".."),{recursive:true});
  await writeFile(temp,JSON.stringify(checkpoint),"utf8");
  await rename(temp,path);
}
export function createHomeSource({sol,ingest,dataDir,ownerId,entityIds=[],enabled=false,intervalMs=60000,now=()=>new Date()}){
  const filtered=allowlist(Array.isArray(entityIds)?entityIds.join(","):entityIds);
  const file=join(dataDir,"pulse-home-checkpoint.json");
  let timer=null,busy=false,running=false,lastPollAt=null,lastSuccessAt=null,lastError=null,lastEmitted=0,initialized=false;
  async function tick() {
    if(!enabled||!ownerId||!sol?.enabled||!filtered.length)return {skipped:"not_configured"};
    if(busy)return {skipped:"busy"};
    busy=true;lastPollAt=now().toISOString();
    try {
      const next={};
      for(const entityId of filtered){
        const payload=await sol.request("/v1/plugin-api/mcp/tools/invoke-read",{
          body:{name:"home_assistant_get_state",arguments:{entityId}}
        });
        if(payload?.entityId!==entityId||typeof payload?.state!=="string")throw new Error("invalid_home_state");
        next[entityId]={entityId,state:payload.state,lastChanged:payload.lastChanged||null};
      }
      const old=await readCheckpoint(file);
      initialized=Boolean(old);
      const signals=old?filtered.map(id=>stateSignal(old.states[id],next[id],ownerId)).filter(Boolean):[];
      lastEmitted=0;
      for(const signal of signals){
        const result=await ingest(signal);
        if(result?.ok!==true)throw new Error("home_ingest_failed");
        if(!result.deduplicated)lastEmitted++;
      }
      await persist(file,{version:1,states:next,updatedAt:now().toISOString()});
      initialized=true;lastSuccessAt=now().toISOString();lastError=null;
      return {ok:true,baselined:!old,observed:filtered.length,emitted:lastEmitted};
    }catch(e){lastError=String(e?.message||e).slice(0,180);return {ok:false,error:lastError};}
    finally{busy=false;}
  }
  function start(){if(!enabled||!ownerId||!sol?.enabled||!filtered.length||running)return false;
    running=true;timer=setInterval(()=>void tick(),Math.max(30000,intervalMs));timer.unref?.();void tick();return true;}
  function stop(){running=false;if(timer)clearInterval(timer);timer=null;}
  function status(){return {configured:!!(enabled&&ownerId&&sol?.enabled&&filtered.length),running,watchedEntities:filtered.length,lastPollAt,lastSuccessAt,lastError,lastEmitted,initialized};}
  return {start,stop,tick,status};
}
