import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { spawn } from "node:child_process";
import { SolPluginClientCore } from "./lib/sol-client-core.mjs";

const clean = (x, max = 500) => String(x ?? "").trim().slice(0, max);
const integer = (x, fallback, min, max) => Number.isFinite(Number(x)) ? Math.max(min, Math.min(max, Math.floor(Number(x)))) : fallback;
const config = {
  site: clean(process.env.EDUCACION_MOODLE_SITE || "https://campusisco.com.ar").replace(/\/$/, ""),
  token: clean(process.env.EDUCACION_MOODLE_TOKEN, 4096),
  student: clean(process.env.EDUCACION_STUDENT_NAME || "Luca", 100),
  port: integer(process.env.EDUCACION_API_PORT, 8783, 1024, 65535),
  syncMs: integer(process.env.EDUCACION_SYNC_HOURS, 6, 1, 168) * 3600000,
  maxBytes: integer(process.env.EDUCACION_MAX_FILE_MB, 25, 1, 100) * 1024 * 1024
};
const siteOrigin = new URL(config.site).origin;
if (!/^https:\/\//i.test(config.site)) throw new Error("EDUCACION_MOODLE_SITE must use HTTPS");
const dataRoot = join(process.env.SOL_PLUGIN_DATA_DIR?.trim() || join(process.cwd(), ".data"), "educacion");
const docsDir = join(dataRoot, "archivos");
const indexPath = join(dataRoot, "index.json");
const sol = new SolPluginClientCore();
const pluginId = clean(process.env.SOL_PLUGIN_ID || "educacion");
const callbackPath = "/mcp/" + randomBytes(24).toString("base64url");
const callbackUrl = "http://127.0.0.1:" + config.port + callbackPath;
let registered = [], registrationError = null, syncing = false, lastError = null;
let snapshot = { version: 1, provider: "moodle", student: config.student, userId: null, lastSync: null, courses: [], materials: [], assignments: [], events: [], statistics: {} };
let latestSync = null;

// Agente especializado escolar: solo lectura Nexo/Moodle y borradores revisables.
let agentRunning = false, agentLastAttempt = null, agentLastResult = null, agentLastLocalDay = null;
const agentStatePath = join(dataRoot, "agente.json");
const agentPath = join(import.meta.dirname, "education_agent.py");
const AGENT_HOUR = integer(process.env.EDUCACION_AGENT_HOUR, 18, 0, 23);
function localDayHour() {
  const items = new Intl.DateTimeFormat("en-CA", {timeZone:"America/Argentina/Buenos_Aires", year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hourCycle:"h23"}).formatToParts(new Date());
  const v=Object.fromEntries(items.map(x=>[x.type,x.value]));
  return {day:v.year+"-"+v.month+"-"+v.day,hour:Number(v.hour)};
}
async function agentState(){
  try {return JSON.parse(await readFile(agentStatePath,"utf8"));}
  catch(error){if(error.code==="ENOENT")return {lastRun:null,lastLocalDay:null,events:[],lastError:null};throw error;}
}
async function agentStatus(){
  const s=await agentState();
  return {running:agentRunning,scope:"todos los chats INPUT disponibles en Nexo",
    schedule:"diario "+AGENT_HOUR+":00",timezone:"America/Argentina/Buenos_Aires",
    lastAttempt:agentLastAttempt,lastRun:s.lastRun,lastError:s.lastError,
    stats:s.stats||null,drafts:s.events?.filter(x=>x.estado==="pendiente_revision").length||0,
    suspects:s.events?.filter(x=>x.estado==="por_confirmar").length||0,
    automaticSend:(await deliveryStatus()).enabled,lastExecution:agentLastResult,delivery:await deliveryStatus()};
}
async function runAgent(){
  if(agentRunning)return {started:false,error:"agent_running"};
  if(!snapshot.lastSync)return {started:false,error:"moodle_not_synced"};
  agentRunning=true;agentLastAttempt=new Date().toISOString();agentLastLocalDay=localDayHour().day;
  const child=spawn("python",[agentPath],{cwd:import.meta.dirname,windowsHide:true,
    env:{...process.env,SOL_PLUGIN_DATA_DIR:process.env.SOL_PLUGIN_DATA_DIR||join(process.cwd(),".data")},
    stdio:["ignore","pipe","pipe"]});
  let out="",err="";
  child.stdout.on("data",buf=>{out=(out+String(buf)).slice(-10000);});
  child.stderr.on("data",buf=>{err=(err+String(buf)).slice(-1500);});
  child.on("error",e=>{agentLastResult={ok:false,error:e.message};agentRunning=false;});
  child.on("exit",code=>{
    try{agentLastResult=JSON.parse(out.trim().split(/\r?\n/).at(-1)||"{}");}
    catch{agentLastResult={ok:false,error:"python_exit_"+code+":"+err.slice(-300)};}
    agentRunning=false;
  });
  return {started:true,at:agentLastAttempt};
}
// Envíos autorizados, recordatorios y consultas de datos faltantes.
let deliveryRunning=false, deliveryResult=null, deliveryScheduleTimer=null;
const deliveryScript=join(import.meta.dirname,"education_delivery.py");
async function deliveryStatus(){
  const policyPath=join(dataRoot,"delivery-policy.json");
  const ledgerPath=join(dataRoot,"delivery-ledger.json");
  let enabled=false, sentCount=0, lastDeliveryRun=null, lastError=null;
  try {const p=JSON.parse(await readFile(policyPath,"utf8"));enabled=p.enabled===true&&p.standingAuthorization===true;}
  catch(error){if(error.code!=="ENOENT")lastError=clean(error.message,180);}
  try {const l=JSON.parse(await readFile(ledgerPath,"utf8"));sentCount=Object.keys(l.sent||{}).length;
    lastDeliveryRun=l.lastRun||null;lastError=l.lastError?.[0]||lastError;}
  catch(error){if(error.code!=="ENOENT")lastError=clean(error.message,180);}
  return {enabled,running:deliveryRunning,sentCount,lastDeliveryRun,lastError,automaticSend:enabled,
    reminderDays:[2,1],channels:["WhatsApp padre","WhatsApp alumno"],calendar:"puente Google Calendar separado"};
}
async function runDelivery(){
  if(deliveryRunning || agentRunning)return {started:false,reason:"busy"};
  const policy=await deliveryStatus();
  if(!policy.enabled)return {started:false,reason:"policy_missing"};
  deliveryRunning=true;
  const proc=spawn("python",[deliveryScript],{cwd:import.meta.dirname,windowsHide:true,
     env:{...process.env,SOL_PLUGIN_DATA_DIR:process.env.SOL_PLUGIN_DATA_DIR||join(process.cwd(),".data")},
     stdio:["ignore","pipe","pipe"]});
  let output="",error="";
  proc.stdout.on("data",b=>{output=(output+String(b)).slice(-12000);});
  proc.stderr.on("data",b=>{error=(error+String(b)).slice(-1500);});
  proc.on("error",e=>{deliveryResult={ok:false,error:e.message};deliveryRunning=false;});
  proc.on("exit",code=>{
     try{deliveryResult=JSON.parse(output.trim().split(/\r?\n/).at(-1)||"{}");}
     catch{deliveryResult={ok:false,error:"delivery_exit_"+code+":"+error.slice(-300)};}
     deliveryRunning=false;
  });
  return {started:true};
}
let agentScheduleTimer=null;
async function agentDailyTick(){
  const clock=localDayHour();
  if(clock.hour<AGENT_HOUR||agentRunning)return;
  const s=await agentState();
  if(s.lastLocalDay===clock.day || agentLastLocalDay===clock.day)return;
  await runAgent();
}


function safeName(value) {
  return clean(value, 140).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+/, "_") || "archivo";
}
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function norm(value) { return clean(value, 100000).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }
function iso(seconds) { const x = Number(seconds); return x > 0 ? new Date(x * 1000).toISOString() : null; }
function publicStatus() {
  return { ok: true, provider: "moodle", student: config.student, site: config.site,
    configured: !!config.token, syncing, lastSync: snapshot.lastSync, lastError,
    courses: snapshot.courses.length, materials: snapshot.materials.length,
    downloaded: snapshot.materials.filter(x=>x.localPath).length,
    indexedTexts: snapshot.materials.filter(x=>x.text).length,
    assignments: snapshot.assignments.length, events: snapshot.events.length,
    classroom: "pendiente", registeredTools: registered.length, registrationError };
}
async function load() {
  await mkdir(docsDir, {recursive:true});
  try { snapshot = { ...snapshot, ...JSON.parse(await readFile(indexPath, "utf8")) }; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
async function persist(next) {
  await mkdir(dataRoot, {recursive:true});
  const tmp = indexPath + "." + process.pid + ".tmp";
  await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await rename(tmp, indexPath);
  snapshot = next;
}
async function moodle(functionName, params={}) {
  if (!config.token) throw new Error("moodle_token_not_configured");
  const body = new URLSearchParams({ wstoken: config.token, wsfunction: functionName, moodlewsrestformat: "json" });
  for (const [key,value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((v, i) => body.set(key + "[" + i + "]", String(v)));
    else if (value !== null && value !== undefined) body.set(key, String(value));
  }
  const response = await fetch(config.site + "/webservice/rest/server.php", {
    method: "POST", headers: {"content-type":"application/x-www-form-urlencoded"},
    body, signal:AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error("moodle_http_" + response.status);
  const payload = await response.json();
  if (payload?.exception || payload?.errorcode) throw new Error("moodle_" + clean(payload.errorcode || payload.exception, 80));
  return payload;
}
async function extractText(filePath) {
  const allowed = [".pdf",".docx",".pptx",".xlsx",".txt",".csv",".md",".html",".htm",".png",".jpg",".jpeg",".webp",".bmp",".tif",".tiff"];
  if (!allowed.includes(extname(filePath).toLowerCase())) return {text:"",note:"formato no extraíble"};
  return new Promise(resolve => {
    const child = spawn("python", [join(import.meta.dirname, "extract_text.py"), filePath, "60000"], {
      windowsHide:true, shell:false, stdio:["ignore","pipe","pipe"]
    });
    let text = "", errors = "";
    child.stdout.on("data",b=>{text += String(b).slice(0, Math.max(0, 65000-text.length));});
    child.stderr.on("data",b=>{errors += String(b).slice(0, 500);});
    const timer=setTimeout(()=>child.kill(),120000);
    child.on("error", e=>{clearTimeout(timer); resolve({text:"",note:"Extractor no disponible: "+e.code});});
    child.on("close",code=>{clearTimeout(timer); resolve(code===0
      ? {text:text.slice(0,60000),note:text.trim() ? null : "Sin texto seleccionable; posiblemente PDF escaneado"}
      : {text:"",note:clean(errors,300)||"No se pudo extraer texto"});});
  });
}
async function download(item, existing) {
  if (!item.url) return {...item, note:"Sin enlace de descarga"};
  const target = new URL(item.url, config.site);
  if (target.origin !== siteOrigin || target.protocol !== "https:") return {...item,note:"Enlace externo: no se descarga"};
  const extension = extname(item.fileName || "").toLowerCase();
  const name = hash(item.id).slice(0,16) + extension;
  const output = join(docsDir, name);
  const signature = hash([item.url,item.fileSize,item.modified,item.fileName].join("|"));
  if (existing?.signature === signature && existing?.localPath) {
    try {
      await stat(existing.localPath);
      const stale = !String(existing.text || "").trim() && (
        /Sin texto|formato no extra|EXTRACTION_ERROR|Extractor no disponible/i.test(existing.note || "")
      );
      const reindexed = stale ? await extractText(existing.localPath) : null;
      return {...item,signature,localPath:existing.localPath,
        text:reindexed ? reindexed.text : (existing.text || ""),
        note:reindexed ? reindexed.note : (existing.note || null),sha256:existing.sha256};
    } catch {}
  }
  target.searchParams.set("token", config.token);
  try {
    const response = await fetch(target, {redirect:"manual",signal:AbortSignal.timeout(60000)});
    if (!response.ok) throw new Error("HTTP "+response.status);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > config.maxBytes) throw new Error("Archivo excede el límite configurado");
    const parts=[]; let total=0;
    if (!response.body) throw new Error("Respuesta sin archivo");
    for await (const part of response.body) {
      total += part.length; if (total > config.maxBytes) throw new Error("Archivo excede el límite configurado");
      parts.push(part);
    }
    const bytes=Buffer.concat(parts);
    // Moodle puede responder errores JSON con HTTP 200: no guardarlos como apuntes.
    if (bytes.length && bytes[0] === 123) {
      try {
        const maybeError = JSON.parse(bytes.toString("utf8"));
        if (maybeError?.errorcode || maybeError?.exception || maybeError?.error) {
          throw new Error("moodle_file_" + clean(maybeError.errorcode || maybeError.exception || "error", 80));
        }
      } catch (error) {
        if (String(error.message).startsWith("moodle_file_")) throw error;
      }
    }
    if (extension === ".pdf" && !bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
      throw new Error("invalid_pdf_response");
    }
    if ([".docx",".pptx",".xlsx"].includes(extension) && !bytes.subarray(0, 8).includes(Buffer.from("PK"))) {
      throw new Error("invalid_office_response");
    }
    const temp=output+"."+process.pid+".tmp";
    await writeFile(temp,bytes); await rename(temp,output);
    const extracted=await extractText(output);
    return {...item,signature,sha256:hash(bytes),localPath:output,text:extracted.text,note:extracted.note};
  } catch(error) {
    return {...item, signature:existing?.signature || null,localPath:existing?.localPath || null,
      sha256:existing?.sha256 || null,text:existing?.text || "",note:"Descarga: "+clean(error.message,160)};
  }
}
function flattenSections(course, sections) {
  const found=[];
  for (const section of sections || []) {
    for (const module of section.modules || []) {
      for (const [index, file] of (module.contents || []).entries()) {
        if (!file.fileurl || file.type && file.type !== "file") continue;
        const fileName=clean(file.filename || file.name || module.name,240);
        const key=["moodle",course.id,module.id,index,file.filepath || "",fileName].join(":");
        found.push({id:hash(key).slice(0,24), provider:"moodle",student:config.student,
          courseId:Number(course.id),course:course.fullname,section:clean(section.name,250),
          title:clean(module.name,250),moduleType:clean(module.modname,40),
          fileName,fileSize:Number(file.filesize || 0),modified:Number(file.timemodified || 0),
          url:clean(file.fileurl,2000),resourceId:Number(module.id),page:config.site+"/mod/"+clean(module.modname,40)+"/view.php?id="+module.id});
      }
      if (module.modname === "url") {
        found.push({id:hash("url:"+course.id+":"+module.id).slice(0,24),provider:"moodle",student:config.student,
          courseId:Number(course.id),course:course.fullname,section:clean(section.name,250),title:clean(module.name,250),
          moduleType:"url",fileName:"",fileSize:0,modified:0,url:"",externalUrl:clean(module.contents?.[0]?.fileurl || "",2000),
          resourceId:Number(module.id),page:config.site+"/mod/url/view.php?id="+module.id});
      }
    }
  }
  return found;
}
async function synchronize() {
  if (syncing) return { ok:false, reason:"sync_in_progress" };
  syncing=true; lastError=null;
  try {
    if (!config.token) throw new Error("moodle_token_not_configured");
    const user=await moodle("core_webservice_get_site_info");
    const courses=await moodle("core_enrol_get_users_courses",{userid:user.userid});
    if (!Array.isArray(courses)) throw new Error("invalid_courses_response");
    const previous=new Map(snapshot.materials.map(x=>[x.id,x]));
    const materials=[], errors=[];
    for (const course of courses) {
      try {
        const sections=await moodle("core_course_get_contents",{courseid:course.id});
        for (const item of flattenSections(course,sections)) {
          const earlier=previous.get(item.id);
          materials.push(item.moduleType==="url" ? item : await download(item,earlier));
        }
      } catch(error) { errors.push({courseId:course.id,error:clean(error.message,120)});
        materials.push(...snapshot.materials.filter(x=>x.courseId===Number(course.id)));
      }
    }
    let assignments=snapshot.assignments || [], events=snapshot.events || [];
    try {
      const data=await moodle("mod_assign_get_assignments",{courseids:courses.map(x=>x.id)});
      assignments=(data.courses || []).flatMap(c=>(c.assignments || []).map(a=>({
        id:Number(a.id),student:config.student,courseId:Number(c.id),course:clean(c.fullname,250),
        title:clean(a.name,250),dueAt:iso(a.duedate),cutoffAt:iso(a.cutoffdate),modifiedAt:iso(a.timemodified),
        description:clean(a.intro,1200),url:config.site+"/mod/assign/view.php?id="+a.cmid
      })));
    } catch(error) {errors.push({part:"assignments",error:clean(error.message,120)});}
    try {
      const data=await moodle("core_calendar_get_calendar_events",{"options[userevents]":1,"options[siteevents]":1});
      events=(data.events || []).map(e=>({id:Number(e.id),name:clean(e.name,250),courseId:Number(e.courseid || 0),
        description:clean(e.description,900),startAt:iso(e.timestart),duration:Number(e.timeduration||0),
        eventType:clean(e.eventtype,60),url:clean(e.url,1000)}));
    } catch(error) {errors.push({part:"calendar",error:clean(error.message,120)});}
    const now=new Date().toISOString();
    await persist({version:1,provider:"moodle",student:config.student,userId:Number(user.userid),lastSync:now,
      courses:courses.map(c=>({id:Number(c.id),fullname:clean(c.fullname,250),shortname:clean(c.shortname,120),url:config.site+"/course/view.php?id="+c.id})),
      materials,assignments,events,statistics:{warnings:errors,syncedCourses:courses.length}});
    return {ok:true,...publicStatus(),warnings:errors};
  } catch(error) {lastError=clean(error.message,200); return {ok:false,error:lastError,...publicStatus()};}
  finally {syncing=false;}
}
function searchMaterials(args={}) {
  const q=norm(args.query || ""),course=norm(args.materia || "");
  return snapshot.materials.filter(m=>(!course || norm(m.course).includes(course)) &&
    (!q || norm([m.course,m.section,m.title,m.fileName,m.text].join(" ")).includes(q)))
    .slice(0,integer(args.limit,30,1,100))
    .map(({text,sha256,signature,url,...safe})=>({...safe,
      textPreview:clean(text,integer(args.previewChars,800,0,3000)),hasText:!!String(text || "").trim(),sha256}));
}
const limitTool={type:"integer",minimum:1,maximum:100};
const tools=[
 {name:"educacion_estado",description:"Estado del plugin Educación, sincronización Moodle, alumnos y biblioteca escolar.",inputSchema:{type:"object",properties:{},additionalProperties:false},requiredScope:"read"},
 {name:"educacion_materias",description:"Lista materias de Luca desde Campus ISCO, con IDs Moodle.",inputSchema:{type:"object",properties:{},additionalProperties:false},requiredScope:"read"},
 {name:"educacion_materiales_buscar",description:"Busca material educativo por materia, tema, nombre de archivo o texto extraído. Devuelve procedencia y vista previa.",inputSchema:{type:"object",properties:{query:{type:"string",maxLength:250},materia:{type:"string",maxLength:200},limit:limitTool,previewChars:{type:"integer",minimum:0,maximum:3000}},additionalProperties:false},requiredScope:"read"},
 {name:"educacion_material_leer",description:"Lee texto extraído de un material Moodle indexado por id; informa si es un PDF escaneado.",inputSchema:{type:"object",properties:{id:{type:"string",minLength:1,maxLength:100},maxChars:{type:"integer",minimum:1000,maximum:60000}},required:["id"],additionalProperties:false},requiredScope:"read"},
 {name:"educacion_tareas",description:"Tareas y fechas de entrega de las materias escolares.",inputSchema:{type:"object",properties:{materia:{type:"string",maxLength:200},limit:limitTool},additionalProperties:false},requiredScope:"read"},
 {name:"educacion_calendario",description:"Eventos del calendario de Moodle del alumno.",inputSchema:{type:"object",properties:{limit:limitTool},additionalProperties:false},requiredScope:"read"},
 {name:"educacion_sincronizar",description:"Sincroniza todas las materias, archivos, actividades y eventos de Moodle. Requiere autorización explícita.",inputSchema:{type:"object",properties:{confirmedByUser:{type:"boolean",const:true}},required:["confirmedByUser"],additionalProperties:false},requiredScope:"submit"},
 {name:"educacion_agente_estado",description:"Estado del agente Codex Educación y su revisión diaria de todos los chats INPUT de Nexo.",inputSchema:{type:"object",properties:{},additionalProperties:false},requiredScope:"read"},
 {name:"educacion_evaluaciones",description:"Lista evaluaciones y borradores de guías del agente escolar, sin reenviar mensajes privados.",inputSchema:{type:"object",properties:{limit:{type:"integer",minimum:1,maximum:100}},additionalProperties:false},requiredScope:"read"},
 {name:"educacion_agente_ejecutar",description:"Iniciar ahora el análisis educativo de todos los chats INPUT de Nexo y preparar guías pendientes de revisión. No envía WhatsApp.",inputSchema:{type:"object",properties:{confirmedByUser:{type:"boolean",const:true}},required:["confirmedByUser"],additionalProperties:false},requiredScope:"actions"}
];
async function dispatch(name,args={}) {
  if (name==="educacion_agente_estado") return await agentStatus();
  if (name==="educacion_evaluaciones") {
    const x=await agentState();return {lastRun:x.lastRun,events:(x.events||[]).slice(-integer(args.limit,30,1,100)).reverse()};
  }
  if (name==="educacion_agente_ejecutar") {
    if(args.confirmedByUser!==true)throw new Error("confirmedByUser_required");
    return await runAgent();
  }
  if (name==="educacion_estado") return publicStatus();
  if (name==="educacion_materias") return {student:config.student,lastSync:snapshot.lastSync,courses:snapshot.courses};
  if (name==="educacion_materiales_buscar") return {student:config.student,lastSync:snapshot.lastSync,results:searchMaterials(args)};
  if (name==="educacion_material_leer") {
    const item=snapshot.materials.find(x=>x.id===args.id);
    if (!item) throw new Error("material_not_found");
    const {signature,url, ...rest}=item;
    return {...rest,text:clean(item.text,integer(args.maxChars,30000,1000,60000))};
  }
  if (name==="educacion_tareas") return {student:config.student,items:snapshot.assignments.filter(x=>!args.materia||norm(x.course).includes(norm(args.materia)))
    .sort((a,b)=>String(a.dueAt||"z").localeCompare(String(b.dueAt||"z"))).slice(0,integer(args.limit,50,1,100))};
  if (name==="educacion_calendario") return {student:config.student,items:snapshot.events
    .sort((a,b)=>String(a.startAt).localeCompare(String(b.startAt))).slice(0,integer(args.limit,50,1,100))};
  if (name==="educacion_sincronizar") {
    if (args.confirmedByUser!==true) throw new Error("confirmedByUser_required");
    return await synchronize();
  }
  throw new Error("tool_not_found");
}
function send(res,status,body){res.statusCode=status;res.setHeader("content-type","application/json; charset=utf-8");res.end(JSON.stringify(body));}
async function readBody(req){
  let bytes=0,parts=[];
  for await(const part of req){bytes+=part.length;if(bytes>1048576)throw new Error("request_too_large");parts.push(part);}
  return parts.length?JSON.parse(Buffer.concat(parts).toString("utf8")):{};
}
async function register(){
  if(!sol.enabled) return;
  try {registered=(await sol.registerMcpTools(callbackUrl,tools)).map(x=>x.name);registrationError=null;}
  catch(e){registrationError=clean(e.message,200);}
}
const server=createServer(async(req,res)=>{
  try {
    const pathname=new URL(req.url||"/","http://127.0.0.1").pathname;
    if(req.method==="GET"&&pathname==="/health") return send(res,200,publicStatus());
    if(req.method!=="POST"||pathname!==callbackPath) return send(res,404,{error:"not_found"});
    const data=await readBody(req);
    if(data.pluginId!==pluginId) return send(res,403,{error:"plugin_id_mismatch"});
    if(data.type==="sol.plugin.mcp.probe") return send(res,200,{ok:true,pluginId});
    if(data.type!=="sol.plugin.mcp.invoke") return send(res,403,{error:"invalid_plugin_mcp_envelope"});
    const result=await dispatch(clean(data.tool,100),data.arguments||{});
    return send(res,200,result);
  }catch(e){return send(res,400,{error:clean(e.message,200)});}
});
await load();
server.listen(config.port,"127.0.0.1",async()=>{
 console.log(JSON.stringify({type:"sol.plugin.ready",health:"healthy",details:{provider:"educacion",port:config.port,configured:!!config.token}}));
 await register();
 if(config.token) void synchronize();
 agentScheduleTimer=setInterval(()=>void agentDailyTick().catch(e=>console.warn("Education agent schedule:",e.message)),5*60000);
 agentScheduleTimer.unref?.();
 deliveryScheduleTimer=setInterval(()=>void runDelivery().catch(e=>console.warn("Education delivery:",e.message)),5*60000);
 deliveryScheduleTimer.unref?.();
 setTimeout(()=>void runDelivery().catch(e=>console.warn("Education delivery initial:",e.message)),15000).unref?.();
});
const timer=setInterval(()=>{if(config.token) void synchronize();if(registered.length!==tools.length) void register();},config.syncMs);
const retry=setInterval(()=>{if(registered.length!==tools.length)void register();},15000);
timer.unref?.();retry.unref?.();
let stopping=false;
async function shutdown(){
 if(stopping)return;stopping=true;clearInterval(timer);clearInterval(retry);if(agentScheduleTimer)clearInterval(agentScheduleTimer);if(deliveryScheduleTimer)clearInterval(deliveryScheduleTimer);
 if(sol.enabled)await sol.registerMcpTools(callbackUrl,[]).catch(()=>{});
 server.close();process.exit(0);
}
process.on("SIGINT",()=>void shutdown());
process.on("SIGTERM",()=>void shutdown());
