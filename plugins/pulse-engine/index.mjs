import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { SolPluginClientCore } from "./lib/sol-client-core.mjs";
import { localClock, quietHour, urgentAllowed, messageFor, digestText, sendWhatsApp } from "./notifier.mjs";
import { createFinanceSource } from "./finance-source.mjs";
import { createHomeSource } from "./home-source.mjs";
import { createPanoramaSource } from "./panorama-source.mjs";

const pluginId = process.env.SOL_PLUGIN_ID?.trim() || "pulse-engine";
const dataDir = process.env.SOL_PLUGIN_DATA_DIR?.trim() || join(process.env.SOL_PLUGIN_ROOT?.trim() || process.cwd(), ".data");
const storePath = join(dataDir, "pulse-events.json");
const port = Number(process.env.PULSE_ENGINE_API_PORT || 8794);
const secretPath = "/mcp/" + randomBytes(24).toString("base64url");
const callbackUrl = "http://127.0.0.1:" + port + secretPath;
const sol = new SolPluginClientCore();
const ingestToken = process.env.PULSE_ENGINE_INGEST_TOKEN?.trim() || "";
const allowedOwner = process.env.PULSE_ENGINE_INGEST_OWNER_ID?.trim() || "";
const ingestEnabled = ingestToken.length >= 32 && allowedOwner.length > 0;
const deliveryEnabled = process.env.PULSE_DELIVERY_ENABLED === "true";
const recipient = String(process.env.PULSE_WHATSAPP_TO||"").trim();
const nexoUrl = "http://127.0.0.1:"+(Number(process.env.PULSE_NEXO_PORT)||3210)+"/api/automation/pulse/send";
const nexoToken=String(process.env.PULSE_NEXO_AUTOMATION_TOKEN||"").trim();
const maxDaily = 8;
const deliveryReady = deliveryEnabled && ingestEnabled && nexoToken.length>=32 && /^[1-9]\d{9,14}$/.test(recipient);
let delivering = false;
function authorized(req){
  if (!ingestEnabled) return false;
  const supplied = String(req.headers.authorization || "");
  const expected = "Bearer "+ingestToken;
  const a=Buffer.from(supplied),b=Buffer.from(expected);
  return a.length===b.length && timingSafeEqual(a,b);
}
const MAX_EVENTS = 5000;
const SOURCES = new Set(["home_assistant","location","mercadolibre","calendar","weather","news","gmail","whatsapp","bambuddy","educacion","finanzas","panorama","other"]);
let store = {version:1, events:[], updatedAt:null};
let writeChain = Promise.resolve();
let toolsRegistered = false;
let lastRegistrationError = null;
const financeSource=createFinanceSource({sol,ownerId:allowedOwner,enabled:process.env.PULSE_FINANCE_ENABLED==="true",ingest});
const homeSource=createHomeSource({sol,ownerId:allowedOwner,enabled:process.env.PULSE_HOME_ENABLED==="true",entityIds:process.env.PULSE_HOME_ENTITIES||"",dataDir,ingest});
const panoramaSource=createPanoramaSource({sol,ownerId:allowedOwner,enabled:process.env.PULSE_PANORAMA_ENABLED==="true",intervalMs:Number(process.env.PULSE_PANORAMA_POLL_MS)||180000,dataDir,ingest});

export function classify(e) {
  const critical = /security|smoke|fire|flood|emergency|critical/i.test(e.type);
  const high = /claim|failure|error|deadline|overdue|exam|storm|delivery/i.test(e.type);
  const low = /heartbeat|routine|telemetry|position/i.test(e.type);
  const importance = Number.isFinite(e.importance) ? Math.max(0, Math.min(100, Math.round(e.importance))) : critical ? 95 : high ? 78 : low ? 15 : 50;
  return {importance, decision:importance >= 70 ? "review" : importance >= 30 ? "digest" : "ignore", reason:critical?"critical_keyword":high?"high_priority_keyword":low?"routine_keyword":"base_priority"};
}
export function normalize(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_event");
  const source=String(input.source||"").trim().toLowerCase();
  const type=String(input.type||"").trim().toLowerCase();
  const sourceEventId=String(input.sourceEventId||"").trim();
  const ownerId=String(input.ownerId||"").trim();
  if (!SOURCES.has(source) || !/^[a-z0-9_.:-]{3,90}$/.test(type) || !sourceEventId || sourceEventId.length>160 || !ownerId || ownerId.length>120) throw new Error("invalid_event_fields");
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) throw new Error("invalid_occurredAt");
  const title=String(input.title||type).trim().slice(0,160);
  const privacy=["public","household","private","sensitive"].includes(input.privacy) ? input.privacy : "private";
  const importance = input.importance===undefined ? undefined : Number(input.importance);
  if (importance!==undefined && (!Number.isFinite(importance) || importance<0 || importance>100)) throw new Error("invalid_importance");
  const idempotencyKey=createHash("sha256").update(JSON.stringify([source, ownerId, sourceEventId])).digest("hex");
  const message=source==="panorama" && typeof input.message==="string" ? input.message.replace(/[\u0000-\u001f]/g," ").slice(0,1100) : undefined;
  return {id:randomUUID(),source,type,sourceEventId,ownerId,title,privacy,importance,message,occurredAt:occurredAt.toISOString(),receivedAt:new Date().toISOString(),idempotencyKey};
}
export async function load() {
  try {
    const parsed=JSON.parse(await readFile(storePath,"utf8"));
    if (!Array.isArray(parsed.events)) throw new Error("invalid_store");
    store={version:1,events:parsed.events.slice(-MAX_EVENTS),updatedAt:parsed.updatedAt||null,digests:parsed.digests||{}};
  } catch(error) {if(error?.code!=="ENOENT") throw error;}
}
async function save() {
  await mkdir(dataDir,{recursive:true});
  const tmp=storePath+"."+randomUUID()+".tmp";
  await writeFile(tmp,JSON.stringify(store),"utf8");
  await rename(tmp,storePath);
}
function publicEvent(event) {
  const {id,source,type,privacy,importance,decision,reason,occurredAt,receivedAt,status,deliveryStatus} = event;
  return {id,source,type,privacy,importance,decision,reason,occurredAt,receivedAt,status,deliveryStatus:deliveryStatus||null, title:privacy==="public"?event.title:"[restringido]"};
}
function mutate(task) {
  const job=writeChain.then(task);
  writeChain=job.catch(()=>{});
  return job;
}
export async function ingest(input) {
  const event=normalize(input);
  return mutate(async()=>{
    const prev=store.events.find(x=>x.idempotencyKey===event.idempotencyKey);
    if(prev) return {ok:true,deduplicated:true,event:publicEvent(prev)};
    const {importance,decision,reason}=classify(event);
    const record={...event,importance,decision,reason,status:decision==="review"?"pending":"recorded"};
    const next={...store,version:1,events:[...store.events,record].slice(-MAX_EVENTS),updatedAt:new Date().toISOString()};
    const before=store;store=next;
    try {await save();} catch(error){store=before;throw error;}
    return {ok:true,deduplicated:false,event:publicEvent(record)};
  });
}
export function listEvents(args={}) {
  const limit=Math.min(100,Math.max(1,Number(args.limit)||25));
  const source=args.source ? String(args.source) : null;
  const decision=args.decision ? String(args.decision) : null;
  return {ok:true,events:store.events.filter(x=>(!source||x.source===source)&&(!decision||x.decision===decision)).slice(-limit).reverse().map(publicEvent)};
}
export async function runNotificationCycle({now=new Date(),send=sendWhatsApp}={}) {
  if(!deliveryReady||delivering)return {skipped:"disabled_or_busy"};
  delivering=true;
  try {
    const clock=localClock(now);
    const sentToday=store.events.filter(e=>e.deliveryStatus==="accepted"&&e.deliveredAt&&localClock(new Date(e.deliveredAt)).day===clock.day).length
      + Object.entries(store.digests||{}).filter(([k,v])=>k.startsWith(clock.day+":")&&v.status!=="failed").length;
    if(sentToday>=maxDaily)return {skipped:"daily_limit"};
    const urgent=store.events.find(e=>e.ownerId===allowedOwner&&e.decision==="review"&&e.importance>=80&&!e.deliveryStatus&&urgentAllowed(e,now));
    if(urgent){
      await mutate(async()=>{urgent.deliveryStatus="sending";urgent.deliveryAttemptAt=now.toISOString();await save();});
      try {
        await send({url:nexoUrl,recipient,text:messageFor(urgent),token:nexoToken,eventId:urgent.id});
        await mutate(async()=>{urgent.deliveryStatus="accepted";urgent.deliveredAt=new Date().toISOString();await save();});
        return {sent:"urgent",eventId:urgent.id};
      } catch(error) {
        await mutate(async()=>{urgent.deliveryStatus="uncertain";urgent.deliveryError=String(error?.message||error).slice(0,160);await save();});
        return {uncertain:true,eventId:urgent.id};
      }
    }
    if(quietHour(now))return {skipped:"quiet_hours"};
    const slot=clock.hour>=18?"18":clock.hour>=12?"12":clock.hour>=8?"08":null;
    if(!slot)return {skipped:"outside_digest"};
    const key=clock.day+":"+slot;
    if(store.digests?.[key])return {skipped:"digest_slot_consumed"};
    const candidates=store.events.filter(e=>e.ownerId===allowedOwner&&e.decision==="digest"&&!e.digestSlot&&localClock(new Date(e.receivedAt)).day===clock.day);
    if(!candidates.length)return {skipped:"no_updates"};
    await mutate(async()=>{
      for(const e of candidates)e.digestSlot=key;
      store.digests??={};
      store.digests[key]={status:"sending",at:now.toISOString(),count:candidates.length};
      await save();
    });
    try{
      await send({url:nexoUrl,recipient,text:digestText(candidates),token:nexoToken,eventId:key});
      await mutate(async()=>{store.digests[key].status="accepted";store.digests[key].deliveredAt=new Date().toISOString();await save();});
      return {sent:"digest",count:candidates.length};
    }catch(error){
      await mutate(async()=>{store.digests[key].status="uncertain";store.digests[key].error=String(error?.message||error).slice(0,160);await save();});
      return {uncertain:true,count:candidates.length};
    }
  }finally{delivering=false;}
}
function status() {
  const counts={review:0,digest:0,ignore:0};
  for(const e of store.events) counts[e.decision]=(counts[e.decision]||0)+1;
  return {ok:true,plugin:pluginId,version:"0.7.1",events:store.events.length,counts,updatedAt:store.updatedAt,solEnabled:sol.enabled,toolsRegistered,lastRegistrationError,mode:deliveryReady?"notification":"observe_only",notificationsEnabled:deliveryReady,actionsEnabled:false,ingestEnabled,delivery:{ready:deliveryReady,maxDaily,recipientConfigured:Boolean(recipient),lastDigestKeys:Object.keys(store.digests||{}).slice(-4)},financeSource:financeSource.status(),homeSource:homeSource.status(),panoramaSource:panoramaSource.status()};
}
const tools=[
{name:"pulse_engine_status",description:"Return Pulse Engine health and processing counters. Read-only.",requiredScope:"read",inputSchema:{type:"object",properties:{},additionalProperties:false}},
{name:"pulse_engine_events",description:"List safe redacted event metadata for current SOL plugin scope. Does not return private payload.",requiredScope:"read",inputSchema:{type:"object",properties:{limit:{type:"integer",minimum:1,maximum:100},source:{type:"string"},decision:{type:"string",enum:["review","digest","ignore"]}},additionalProperties:false}},
{name:"pulse_engine_decisions",description:"Review events that merit human inspection; no automatic actions.",requiredScope:"read",inputSchema:{type:"object",properties:{limit:{type:"integer",minimum:1,maximum:100}},additionalProperties:false}},
{name:"pulse_engine_ingest_event",description:"Submit one authorized source event for durable deduplication and classification. Does not trigger messages or actions.",requiredScope:"submit",inputSchema:{type:"object",properties:{source:{type:"string",enum:[...SOURCES]},type:{type:"string",minLength:3,maxLength:90},sourceEventId:{type:"string",minLength:1,maxLength:160},ownerId:{type:"string",minLength:1,maxLength:120},title:{type:"string",maxLength:160},privacy:{type:"string",enum:["public","household","private","sensitive"]},importance:{type:"number",minimum:0,maximum:100},occurredAt:{type:"string",format:"date-time"}},required:["source","type","sourceEventId","ownerId"],additionalProperties:false}}
];
async function register() {
  if(!sol.enabled) return;
  try{const result=await sol.registerMcpTools(callbackUrl,tools);toolsRegistered=result.length===tools.length;lastRegistrationError=null;}
  catch(error){toolsRegistered=false;lastRegistrationError=String(error?.message||error);}
}
function json(res,code,payload){res.writeHead(code,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});res.end(JSON.stringify(payload));}
async function parse(req){
  let s="";for await(const chunk of req){s+=chunk;if(s.length>65536)throw new Error("invalid_body_too_large");}
  return JSON.parse(s||"{}");
}
let server;
export async function start(){
  await mkdir(dataDir,{recursive:true});await load();
  server=createServer(async(req,res)=>{
    const path=new URL(req.url||"/","http://127.0.0.1").pathname;
    if(req.method==="GET"&&path==="/health")return json(res,200,status());
    if(req.method==="POST"&&path==="/v1/ingest"){
      if(!authorized(req))return json(res,401,{error:"unauthorized"});
      try{
        const body=await parse(req);
        if(body?.source!=="mercadolibre"||body?.ownerId!==allowedOwner)return json(res,403,{error:"source_or_owner_not_authorized"});
        return json(res,200,await ingest(body));
      }catch(error){return json(res,400,{error:String(error?.message||error)});}
    }
    if(req.method!=="POST"||path!==secretPath)return json(res,404,{error:"not_found"});
    try{
      const body=await parse(req);
      if(body?.pluginId!==pluginId)return json(res,403,{error:"plugin_id_mismatch"});
      if(body?.type==="sol.plugin.mcp.probe")return json(res,200,{ok:true,pluginId});
      if(body?.type!=="sol.plugin.mcp.invoke")return json(res,403,{error:"invalid_envelope"});
      const name=String(body.tool||"");const args=body.arguments||{};
      let output;
      if(name==="pulse_engine_status")output=status();
      else if(name==="pulse_engine_events")output=listEvents(args);
      else if(name==="pulse_engine_decisions")output=listEvents({...args,decision:"review"});
      else if(name==="pulse_engine_ingest_event"){
        if(!allowedOwner||args.ownerId!==allowedOwner)throw new Error("owner_not_authorized");
        output=await ingest(args);
      }
      else return json(res,404,{error:"tool_not_found"});
      return json(res,200,output);
    }catch(error){return json(res,400,{error:String(error?.message||error)});}
  });
  await new Promise(resolve=>server.listen(port,"127.0.0.1",resolve));
  console.log(JSON.stringify({type:"sol.plugin.ready",health:"healthy",details:{provider:pluginId,port,mode:"observe_only"}}));
  await register();
  financeSource.start();
  homeSource.start();
  panoramaSource.start();
  const retry=setInterval(()=>{if(!toolsRegistered)void register();},15000);retry.unref?.();
  const notifierTimer=setInterval(()=>void runNotificationCycle().catch(error=>console.warn("Pulse notifier: "+String(error?.message||error))),30000);notifierTimer.unref?.();
  for(const sig of ["SIGINT","SIGTERM"])process.once(sig,async()=>{clearInterval(retry);clearInterval(notifierTimer);financeSource.stop();homeSource.stop();panoramaSource.stop();if(sol.enabled)await sol.registerMcpTools(callbackUrl,[]).catch(()=>{});server.close();process.exit(0);});
}
if(process.argv[1]&&new URL(import.meta.url).pathname.replace(/^\//,"").toLowerCase().endsWith(process.argv[1].replaceAll("\\","/").toLowerCase()))await start();
