import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMercadoLibrePulsePoller } from "../bwa-3d/lib/pulse-mercadolibre.mjs";

async function freePort(){
 return await new Promise((resolve,reject)=>{
  const s=createServer();
  s.once("error",reject);
  s.listen(0,"127.0.0.1",()=>{const port=s.address().port;s.close(()=>resolve(port));});
 });
}
async function waitHealth(url){
 for(let i=0;i<60;i++){
  try{const r=await fetch(url+"/health");if(r.ok)return await r.json();}catch{}
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 throw new Error("pulse_server_not_ready");
}
test("BWA order -> trusted local Pulse -> persisted and redacted decision (no message sent)",{timeout:12000},async()=>{
 const temp=await mkdtemp(join(tmpdir(),"pulse-e2e-"));
 const port=await freePort();
 const token="test-token-"+("q".repeat(40));
 const ownerId="test-user-001";
 const url="http://127.0.0.1:"+port;
 const child=spawn(process.execPath,[fileURLToPath(new URL("./entry.mjs",import.meta.url))],{
  env:{...process.env,SOL_PLUGIN_API_URL:"",SOL_PLUGIN_TOKEN:"",SOL_CORE_URL:"",SOL_PLUGIN_DATA_DIR:join(temp,"engine"),PULSE_ENGINE_API_PORT:String(port),PULSE_ENGINE_INGEST_TOKEN:token,PULSE_ENGINE_INGEST_OWNER_ID:ownerId},
  stdio:["ignore","pipe","pipe"],windowsHide:true
 });
 try{
  const init=await waitHealth(url);
  assert.equal(init.ingestEnabled,true);
  assert.equal(init.notificationsEnabled,false);
  const sample={source:"mercadolibre",type:"order.created",sourceEventId:"123456:created",ownerId,privacy:"private",title:"Private order",importance:64};
  const unauthorized=await fetch(url+"/v1/ingest",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(sample)});
  assert.equal(unauthorized.status,401);
  const spoofed=await fetch(url+"/v1/ingest",{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify({...sample,ownerId:"someone-else"})});
  assert.equal(spoofed.status,403);
  let results={results:[{id:123456,status:"paid",date_last_updated:"2026-10-12T12:00:00Z"}]};
  const p=createMercadoLibrePulsePoller({
   dataDir:join(temp,"bwa"),endpoint:url+"/v1/ingest",token,ownerId,
   listOrders:async()=>results
  });
  assert.equal((await p.tick()).emitted,0); // baseline
  results={results:[{id:234567,status:"paid",date_last_updated:"2026-10-12T12:30:00Z"},...results.results]};
  assert.equal((await p.tick()).emitted,1);
  assert.equal((await p.tick()).emitted,0);
  const health=await (await fetch(url+"/health")).json();
  assert.equal(health.events,1);
  assert.equal(health.counts.digest,1);
  assert.equal(health.notificationsEnabled,false);
  const duplicate=await fetch(url+"/v1/ingest",{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify({source:"mercadolibre",type:"order.created",sourceEventId:"234567:created",ownerId,privacy:"private",title:"Private order",importance:64})});
  assert.equal((await duplicate.json()).deduplicated,true);
  assert.equal((await (await fetch(url+"/health")).json()).events,1);
 }finally{child.kill();await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
