import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function localNexoUrl(raw) {
  let url;
  try { url=new URL(raw); } catch { throw new Error("nexo_url_invalid"); }
  if(url.protocol!=="http:" || !["127.0.0.1","localhost","[::1]"].includes(url.hostname) ||
     url.username||url.password||url.search||url.hash || url.pathname!=="/")
    throw new Error("nexo_url_must_be_loopback");
  return url.origin;
}
function localDay(now) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-US",{
    timeZone:"America/Argentina/Buenos_Aires",year:"numeric",month:"2-digit",day:"2-digit"
  }).formatToParts(now).map(x=>[x.type,x.value]));
  return parts.year+"-"+parts.month+"-"+parts.day;
}
function candidate(items, date) {
  return (items||[]).filter(p=>
    p && p.status==="review_only" && p.priority==="high" && Number(p.confidence)>=0.8 &&
    Array.isArray(p.evidence) && p.evidence.length>0 && typeof p.missionId==="string" &&
    typeof p.id==="string" && typeof p.title==="string" && typeof p.rationale==="string" &&
    p.feedback!=="incorrect" && p.feedback!=="irrelevant" &&
    Math.abs(date.getTime()-Date.parse(p.at)) < 4*3600000
  ).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))[0]||null;
}
export function createNexoNotificationPublisher({
  dataDir, enabled=false, token="", baseUrl="http://127.0.0.1:3210",
  proposals, fetcher=fetch, now=()=>new Date()
}) {
  if(typeof proposals!=="function"||!dataDir)throw new Error("nexo_publisher_config_invalid");
  const file=join(dataDir,"sol-agent-nexo-delivery.json");
  let delivered="", active=false;
  async function load() {
    try{
      const value=JSON.parse(await readFile(file,"utf8"));
      if(value?.version!==1||typeof value.day!=="string")throw new Error("nexo_delivery_state_invalid");
      delivered=value.day;
    }catch(e){if(e?.code!=="ENOENT")throw e;}
  }
  async function publish() {
    if(!enabled)return {skipped:"disabled"};
    if(!token || token.length<24)return {skipped:"token_missing"};
    if(active)return {skipped:"busy"};
    const base=localNexoUrl(baseUrl); // Validate before sending the token.
    const day=localDay(now());
    if(delivered===day)return {skipped:"already_delivered"};
    const item=candidate(proposals(),now());
    if(!item)return {skipped:"no_high_priority_finding"};
    active=true;
    try{
      const reply=await fetcher(base+"/api/automation/sol-agent/notify",{
        method:"POST",redirect:"error",
        headers:{authorization:"Bearer "+token,"content-type":"application/json"},
        body:JSON.stringify({
          missionId:item.missionId,proposalId:item.id,priority:"high",
          text:(item.title+"\n"+item.rationale).slice(0,880)
        }),
        signal:AbortSignal.timeout(5000)
      });
      if(!reply.ok)return {ok:false,error:"nexo_http_"+reply.status};
      const result=await reply.json();
      if(result?.sent!==true&&result?.duplicate!==true)return {ok:false,error:"nexo_response_invalid"};
      delivered=day;
      await mkdir(dataDir,{recursive:true});
      const tmp=file+"."+randomUUID()+".tmp";
      await writeFile(tmp,JSON.stringify({version:1,day,proposalId:item.id})+"\n",{encoding:"utf8",mode:0o600});
      await rename(tmp,file);
      return {ok:true,sent:result.sent===true,duplicate:result.duplicate===true};
    }catch(e){return {ok:false,error:"nexo_transport_failed"};}
    finally{active=false;}
  }
  return {load,publish,enabled};
}
