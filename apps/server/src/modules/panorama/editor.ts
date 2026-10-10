import type { TimelineItem } from "../life/timeline.js";

export type EditorialTopic = "school" | "health" | "business" | "finance" | "home" | "family" | "agenda" | "general";
export interface FamilyParticipant { name: string; memberId?: string; aliases?: string[] }
export interface EditorialEvidence {
  item: TimelineItem;
  score: number;
  topic: EditorialTopic;
  person?: string;
  reasons: string[];
}

function plain(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-AR").trim()
    : "";
}
function str(meta: Record<string,unknown> | undefined, key: string): string {
  const v=meta?.[key];
  return typeof v==="string" ? v.slice(0,200) : "";
}
function nameMatch(needle:string, candidate:string):boolean {
  const a=plain(needle), b=plain(candidate);
  if(!a||!b)return false;
  if(a===b)return true;
  const first=b.split(/\s+/)[0];
  return a===first && a.length>=3;
}

/** Attribution only from trusted structured fields, never casual mentions in messages.
 * source.ownerMemberId identifies the plugin account owner, NOT the WhatsApp sender.
 */
export function attributablePerson(item:TimelineItem,participants:FamilyParticipant[]):string|undefined {
  const meta=item.metadata||{};
  const nameFields=["student","studentName","subjectMemberName","personName","memberName","senderName","familyMemberName"];
  let candidates=nameFields.map(k=>str(meta,k)).filter(Boolean);
  // chatName is only a sender-like identity for direct 1:1 WhatsApp chats.
  const jid=str(meta,"chatJid");
  if(item.provider==="whatsapp" && jid && !jid.endsWith("@g.us"))candidates.push(str(meta,"chatName"));
  if(item.type!=="source" && item.ownerMemberId){
    const member=participants.find(p=>p.memberId===item.ownerMemberId);
    if(member)return member.name;
  }
  for(const candidate of candidates) {
    const matches=participants.filter(p=>[p.name,...(p.aliases||[])].some(a=>nameMatch(a,candidate)));
    if(matches.length===1)return matches[0]!.name;
  }
  return undefined;
}

export function editorialTopic(item:TimelineItem):EditorialTopic {
  const p=plain(item.provider);
  const fields=(item.title+" "+(item.summary||"")).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().slice(0,1100);
  const meta=item.metadata||{};
  if(/educacion|moodle|classroom|school/.test(p) || typeof meta.courseId==="number" || typeof meta.student==="string" ||
     /\b(examen|prueba|evaluacion|leccion|recuperatorio|materia|colegio|escuela|temario|trabajo practico|profe|tarea escolar)\b/.test(fields))return "school";
  if(/mercado|bwa|ventas/.test(p) || /\b(reclamo|devolucion|venta|comprador|envio de pedido)\b/.test(fields))return "business";
  if(/\b(doctor|medico|turno de salud|medicamento|hospital|fiebre|guardia medica)\b/.test(fields))return "health";
  if(/\b(factura|vencimiento|impuesto|resumen de cuenta|resumen de tarjeta|cobro pendiente|pagar antes)\b/.test(fields))return "finance";
  if(/home_assistant|hogar/.test(p) || /\b(alarma|sensor|corte de luz|temperatura)\b/.test(fields))return "home";
  if(item.type==="event"||item.type==="task"||/calendar|calendario|agenda/.test(p))return "agenda";
  if(/\b(cumpleanos|cumple|familia|reunion familiar)\b/.test(fields))return "family";
  return "general";
}

function dueDays(item:TimelineItem,now:Date):number|undefined {
  const due=item.metadata?.dueAt;
  if(typeof due!=="string")return undefined;
  const ms=Date.parse(due);
  if(!Number.isFinite(ms))return undefined;
  return (ms-now.getTime())/86_400_000;
}

export function assessEditorialEvidence(item:TimelineItem,participants:FamilyParticipant[]=[],now=new Date()):EditorialEvidence {
  const topic=editorialTopic(item);
  const m=item.metadata||{};
  const text=plain((item.title+" "+(item.summary||"")).slice(0,1300));
  const reasons:string[]=[];
  let score=18;
  if(item.type==="event"){score+=17;reasons.push("evento");}
  if(item.type==="task"){score+=22;reasons.push("tarea");}
  const gate=typeof m.intelligenceScore==="number" ? Math.max(0,Math.min(1,m.intelligenceScore)) : 0;
  if(gate>.5){score+=Math.round(gate*24);reasons.push("senal_importante");}
  if(m.intelligencePriority==="high"){score+=18;reasons.push("prioridad_fuente");}
  if(topic==="school"){score+=29;reasons.push("educacion");}
  if(topic==="health"){score+=27;reasons.push("salud");}
  if(topic==="business"){score+=13;reasons.push("negocio");}
  if(topic==="finance"){score+=24;reasons.push("finanzas");}
  if(topic==="agenda"){score+=13;reasons.push("agenda");}
  if(topic==="family"){score+=10;reasons.push("familia");}
  if(topic==="home")score-=6;
  if(/\b(urgente|alerta critica|emergencia|corte de luz|alarma activada|incidente)\b/.test(text)){score+=32;reasons.push("urgencia");}
  if(/\b(reclamo|devolucion|cancelacion|pedido demorado)\b/.test(text)){score+=21;reasons.push("requiere_seguimiento");}
  if(/\b(examen|prueba|evaluacion|entrega|leccion|recuperatorio)\b/.test(text)){score+=17;reasons.push("compromiso_escolar");}
  if(/\b(pendiente|falta confirmar|sin fecha|por confirmar|sin responder)\b/.test(text)){score+=11;reasons.push("accion_pendiente");}
  if(/\b(publicidad|newsletter|promocion|spam|descuento especial)\b/.test(text)){score-=30;reasons.push("ruido");}
  if(m.fromMe===true && topic==="general")score-=8;
  const day=dueDays(item,now);
  if(day!==undefined && day>=-2 && day<=2){score+=27;reasons.push("vence_pronto");}
  else if(day!==undefined && day>2 && day<=7){score+=12;reasons.push("proximo");}
  else if(day!==undefined && day< -2){score-=8;}
  const person=attributablePerson(item,participants);
  if(person && score>=35){score+=6;reasons.push("integrante_identificado");}
  // Moderate preference for recent developments, never enough to eclipse high priority.
  const eventAge=(now.getTime()-Date.parse(item.occurredAt))/3_600_000;
  if(eventAge>=0&&eventAge<8)score+=4;
  return {item,score:Math.max(0,Math.min(100,score)),topic,person,reasons};
}
function dedupTitle(ev:EditorialEvidence):string {
  return [ev.topic,ev.person||"",plain(ev.item.provider),plain(ev.item.title).replace(/\d{1,2}:\d{2}/g,"").slice(0,130)].join("|");
}

/** Diversify meaningful signals across people/topics/sources.
 * No equal word-count quota: truly urgent items always get precedence.
 */
export function selectEditorialEvidence(
  items:TimelineItem[],participants:FamilyParticipant[]=[],max=85,now=new Date(),
):EditorialEvidence[] {
  const limit=Math.max(1,Math.min(150,Math.trunc(max)));
  const sorted=items.map(i=>assessEditorialEvidence(i,participants,now))
    .filter(x=>x.score>=35)
    .sort((a,b)=>b.score-a.score || b.item.occurredAt.localeCompare(a.item.occurredAt) || a.item.id.localeCompare(b.item.id));
  const chosen:EditorialEvidence[]=[];
  const seenIds=new Set<string>(), seenTitles=new Map<string,number>();
  const sourceCounts=new Map<string,number>();
  const personCounts=new Map<string,number>();
  const topicCounts=new Map<string,number>();
  const sourceLimit=Math.max(12,Math.ceil(limit*.42));
  const personLimit=Math.max(7,Math.ceil(limit*.31));
  const generalLimit=Math.max(10,Math.ceil(limit*.47));
  const add=(e:EditorialEvidence,allowBroad=false):boolean=>{
    if(seenIds.has(e.item.type+":"+e.item.id))return false;
    const fingerprint=dedupTitle(e);
    if((seenTitles.get(fingerprint)||0)>=2)return false;
    const src=plain(e.item.provider)||e.item.type;
    const who=e.person||"__general";
    if(!allowBroad && e.score<90){
      if((sourceCounts.get(src)||0)>=sourceLimit)return false;
      if((personCounts.get(who)||0)>=(e.person?personLimit:generalLimit))return false;
    }
    seenIds.add(e.item.type+":"+e.item.id);
    seenTitles.set(fingerprint,(seenTitles.get(fingerprint)||0)+1);
    sourceCounts.set(src,(sourceCounts.get(src)||0)+1);
    personCounts.set(who,(personCounts.get(who)||0)+1);
    topicCounts.set(e.topic,(topicCounts.get(e.topic)||0)+1);
    chosen.push(e);
    return true;
  };
  // First guarantee a strong, attributable item for each observed family member.
  for(const person of participants){
    const match=sorted.find(e=>e.person===person.name && e.score>=40);
    if(match)add(match);
  }
  // Secure one item per meaningful editorial theme, so e.g. school isn't
  // displaced by 1000 ordinary WhatsApp messages.
  for(const topic of ["school","health","business","finance","agenda","family","home","general"] as const){
    const match=sorted.find(e=>e.topic===topic && e.score>=40);
    if(match)add(match);
  }
  // Critical events are always first, including unassigned people.
  for(const e of sorted.filter(x=>x.score>=85)){if(chosen.length>=limit)break;add(e,true);}
  // Weighted round robin by topic but ranked by impact within each category.
  const groups=new Map<EditorialTopic,EditorialEvidence[]>();
  for(const e of sorted){
    const group=groups.get(e.topic)||[];
    group.push(e);groups.set(e.topic,group);
  }
  const order=[...groups.keys()].sort((a,b)=>(groups.get(b)![0]?.score||0)-(groups.get(a)![0]?.score||0));
  let passes=0;
  while(chosen.length<limit && passes++<sorted.length){
    let progressed=false;
    for(const topic of order){
      const group=groups.get(topic)!;
      while(group.length){
        const e=group.shift()!;
        if(add(e)){progressed=true;break;}
      }
      if(chosen.length>=limit)break;
    }
    if(!progressed)break;
  }
  return chosen.sort((a,b)=>b.score-a.score || a.item.occurredAt.localeCompare(b.item.occurredAt));
}
