import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../../config.js";
import { db } from "../../database/client.js";
import type { AuthPrincipal } from "../auth/session.js";
import type { FamilyParticipant } from "./editor.js";

export interface FamilyPanoramaConfig {
  householdId: string;
  members: FamilyParticipant[];
}
export interface SchoolAgendaEntry {
  id: string;
  student: string;
  subject: string;
  title: string;
  date: string | null;
  kind: "assessment" | "assignment";
  verification: "family-confirmed" | "moodle-published" | "needs-confirmation";
  note?: string;
}
const FAMILY_CONFIG = join(config.dataDir,"panorama-family.json");
const EDUCATION_DATA = join(config.dataDir,"plugin-data","educacion","educacion");
function clean(value:unknown,max=160):string {
  return typeof value==="string" ? value.replace(/[\x00-\x1F]/g," ").trim().slice(0,max) : "";
}
function validDay(date:string):boolean {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return false;
  const parsed=new Date(date+"T12:00:00Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0,10)===date;
}
function dateInZone(value:string):string|null {
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))return null;
  const parts=new Intl.DateTimeFormat("en-US",{
    timeZone:"America/Argentina/Buenos_Aires",year:"numeric",month:"2-digit",day:"2-digit"
  }).formatToParts(date);
  const pick=(name:string)=>parts.find(x=>x.type===name)?.value||"";
  const result=[pick("year"),pick("month"),pick("day")].join("-");
  return validDay(result)?result:null;
}
function daysBetween(a:string,b:string):number {
  return Math.round((Date.parse(b+"T12:00:00Z")-Date.parse(a+"T12:00:00Z"))/86_400_000);
}
async function readBoundedJson(path:string,limit:number):Promise<unknown> {
  try{
    const f=await stat(path);
    if(!f.isFile()||f.size>limit)throw Error("invalid_panorama_file_size");
    return JSON.parse(await readFile(path,"utf8"));
  }catch(error){
    if((error as NodeJS.ErrnoException).code==="ENOENT")return null;
    console.warn("[panorama] local context unavailable",path.split(/[\\/]/).at(-1),error instanceof Error?error.message:String(error));
    return null;
  }
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Opt-in household binding prevents the single-instance Education plugin's
 * private files being read by an unrelated household on the same SOL host.
 */
export async function readFamilyPanoramaConfig():Promise<FamilyPanoramaConfig|null> {
  const json=await readBoundedJson(FAMILY_CONFIG,16_384);
  if(!json||typeof json!=="object"||Array.isArray(json))return null;
  const data=json as Record<string,unknown>;
  if(typeof data.householdId!=="string"||!uuid.test(data.householdId))return null;
  if(!Array.isArray(data.members))return null;
  const members:FamilyParticipant[]=[];
  const seen=new Set<string>();
  for(const item of data.members.slice(0,20)){
    if(!item||typeof item!=="object"||Array.isArray(item))continue;
    const row=item as Record<string,unknown>;
    const name=clean(row.name,70);
    const key=name.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
    if(!name||seen.has(key))continue;
    seen.add(key);
    const aliases=Array.isArray(row.aliases)?row.aliases.slice(0,6).map(a=>clean(a,70)).filter(Boolean):[];
    const memberId=typeof row.memberId==="string"&&uuid.test(row.memberId)?row.memberId:undefined;
    members.push({name, ...(memberId?{memberId}:{}), aliases});
  }
  return {householdId:data.householdId,members};
}
export async function visibleFamilyParticipants(principal:AuthPrincipal):Promise<FamilyParticipant[]> {
  const base=await db.query<{id:string;display_name:string}>(
    "SELECT id,display_name FROM members WHERE household_id=$1 AND status='active' ORDER BY created_at LIMIT 30",
    [principal.householdId],
  );
  const members=base.rows.map(p=>({name:clean(p.display_name,70),memberId:p.id}));
  const cfg=await readFamilyPanoramaConfig();
  if(cfg?.householdId!==principal.householdId)return members;
  const known=new Set(members.map(p=>p.name.toLowerCase()));
  for(const person of cfg.members){
    const existing=members.find(p=>p.name.toLowerCase()===person.name.toLowerCase());
    if(existing) {
      Object.assign(existing,{aliases:person.aliases});
      continue;
    }
    if(!known.has(person.name.toLowerCase())){members.push(person);known.add(person.name.toLowerCase());}
  }
  return members;
}
export function extractSchoolAgenda(
  agent:unknown,moodle:unknown,studentName:string,day:string,horizon=14,
):SchoolAgendaEntry[] {
  if(!validDay(day))return [];
  const a=agent && typeof agent==="object" && !Array.isArray(agent) ? agent as Record<string,unknown> : {};
  const m=moodle && typeof moodle==="object" && !Array.isArray(moodle) ? moodle as Record<string,unknown> : {};
  const student=clean(studentName,70);
  if(!student)return [];
  const entries:SchoolAgendaEntry[]=[];
  const used=new Set<string>();
  const push=(entry:SchoolAgendaEntry)=>{
    if(used.has(entry.id))return;
    used.add(entry.id);
    entries.push(entry);
  };
  // Every assessment comes from the education agent's existing review process.
  // Unknown dates are never guessed. Review-required items remain tentative.
  for(const raw of (Array.isArray(a.events)?a.events:[]).slice(0,500)){
    if(!raw||typeof raw!=="object")continue;
    const x=raw as Record<string,unknown>;
    const subject=clean(x.materia,130), id=clean(x.id,90),status=clean(x.estado,40);
    const iso=clean(x.fecha,10);
    const date=validDay(iso)?iso:null;
    if(!subject||!id)continue;
    if(date && (daysBetween(day,date)<0||daysBetween(day,date)>horizon))continue;
    if(!date && !["por_confirmar","pendiente_revision"].includes(status))continue;
    const confirmation=clean(x.fechaFuente||x.fuente,65).includes("confirmacion");
    const verified=date&&confirmation?"family-confirmed":"needs-confirmation";
    const title=clean(x.temas,160);
    push({
      id:"agent:"+id,student,subject,date,kind: "assessment", verification:verified,
      title:title||"Evaluación o trabajo escolar",note:verified==="needs-confirmation"?"Fecha o temario pendientes de confirmar":undefined,
    });
  }
  // No extracting content from lesson files or messages; only Moodle's
  // published assignment name and deadline are forwarded to Panorama.
  for(const raw of (Array.isArray(m.assignments)?m.assignments:[]).slice(0,500)){
    if(!raw||typeof raw!=="object")continue;
    const x=raw as Record<string,unknown>;
    const subject=clean(x.course,130),id=String(x.id??"").slice(0,70);
    const date=dateInZone(clean(x.dueAt,50));
    if(!subject||!id||!date)continue;
    const left=daysBetween(day,date);
    if(left<0||left>horizon)continue;
    push({id:"moodle:"+id,student,subject,
      title:clean(x.title,170)||"Entrega escolar",date,
      kind:"assignment",verification:"moodle-published",
    });
  }
  return entries.sort((a,b)=>{
    if(a.date&&!b.date)return -1;
    if(!a.date&&b.date)return 1;
    return (a.date||"").localeCompare(b.date||"") || a.subject.localeCompare(b.subject);
  }).slice(0,24);
}
export async function schoolContextFor(
  principal:AuthPrincipal,day:string,currentDay:string
):Promise<SchoolAgendaEntry[]> {
  // Strict boundary: a child, guest or other household must not receive
  // private plugin data just because it happens to be on the same machine.
  if(!["owner","adult"].includes(principal.role)||day!==currentDay)return [];
  const cfg=await readFamilyPanoramaConfig();
  if(!cfg||cfg.householdId!==principal.householdId)return [];
  const [agent,moodle]=await Promise.all([
    readBoundedJson(join(EDUCATION_DATA,"agente.json"),2*1024*1024),
    readBoundedJson(join(EDUCATION_DATA,"index.json"),64*1024*1024),
  ]);
  const student=clean(moodle&&typeof moodle==="object"&&(moodle as Record<string,unknown>).student,70);
  if(!student||!cfg.members.some(x=>x.name.toLowerCase()===student.toLowerCase()))return [];
  return extractSchoolAgenda(agent,moodle,student,day);
}
