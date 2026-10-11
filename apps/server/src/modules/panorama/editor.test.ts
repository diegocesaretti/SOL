import assert from "node:assert/strict";
import { test } from "node:test";
import type { TimelineItem } from "../life/timeline.js";
import { attributablePerson, assessEditorialEvidence, selectEditorialEvidence } from "./editor.js";
import { extractSchoolAgenda } from "./family-school.js";

const roster=[
  {name:"Diego",memberId:"00000000-0000-0000-0000-000000000001"},
  {name:"Mariana"},{name:"Luca"},{name:"Cruz"},
];
function item(id:string,title:string,provider="whatsapp",metadata:Record<string,unknown>={}):TimelineItem {
  return {id,type:"source",provider,title,summary:"",
    occurredAt:"2026-10-10T12:00:00Z",ownerMemberId:roster[0]!.memberId,
    visibility:"private",metadata,
  };
}
const now=new Date("2026-10-10T14:00:00Z");
test("WhatsApp account ownership does not imply message authorship",()=>{
  assert.equal(attributablePerson(item("a","Hola"),roster),undefined);
  assert.equal(attributablePerson(item("b","Hay tarea","whatsapp",{senderName:"Luca Cesaretti"}),roster),"Luca");
  assert.equal(attributablePerson(item("c","Grupo de la escuela","whatsapp",{chatName:"Cruz",chatJid:"120363@g.us"}),roster),undefined);
  assert.equal(attributablePerson(item("d","Llegada","whatsapp",{chatName:"Mariana",chatJid:"549111@s.whatsapp.net"}),roster),"Mariana");
  assert.equal(attributablePerson(item("e","Mensaje que nombra a Mariana"),roster),undefined);
});
test("Urgent school and claims outrank routine home events and chatter",()=>{
  const urgent=item("exam","Mañana hay examen de Matemática","whatsapp",{senderName:"Luca"});
  const claim=item("claim","Reclamo abierto, necesita respuesta","mercadolibre");
  const routine=item("state","Luz cocina encendida","home_assistant");
  assert.ok(assessEditorialEvidence(urgent,roster,now).score>assessEditorialEvidence(routine,roster,now).score);
  assert.ok(assessEditorialEvidence(claim,roster,now).score>assessEditorialEvidence(routine,roster,now).score);
  const many=[...Array.from({length:300},(_,i)=>item(String(i),"Mensaje casual "+i)),
    ...Array.from({length:120},(_,i)=>item("light"+i,"Luz "+i+" encendida","home_assistant")),
    urgent,claim,item("task","Turno médico confirmado","whatsapp",{senderName:"Mariana"}),
    item("family","Cumpleaños familiar","whatsapp",{senderName:"Cruz"})];
  const selected=selectEditorialEvidence(many,roster,12,now);
  assert.ok(selected.some(x=>x.item.id==="exam"));
  assert.ok(selected.some(x=>x.item.id==="claim"));
  assert.ok(selected.some(x=>x.person==="Mariana"));
  assert.ok(selected.some(x=>x.person==="Cruz"));
  assert.ok(selected.length<=12);
});
test("School schedule preserves pending dates as unknown and skips expired Moodle items",()=>{
  const agent={events:[
    {id:"eval",materia:"Matemática",fecha:"2026-10-12",fechaFuente:"confirmacion_familiar_mcp",temas:"Fracciones",estado:"pendiente_revision"},
    {id:"unknown",materia:"Ciudadanía",fecha:null,temas:"",estado:"por_confirmar"},
    {id:"past",materia:"Física",fecha:"2026-10-01",estado:"pendiente_revision"},
  ]};
  const moodle={assignments:[
    {id:1,course:"Inglés",title:"Actividad",dueAt:"2026-10-11T16:00:00Z"},
    {id:2,course:"Arte",title:"Entrega pasada",dueAt:"2025-10-10T16:00:00Z"},
  ]};
  const result=extractSchoolAgenda(agent,moodle,"Luca","2026-10-10",14);
  assert.equal(result.length,3);
  assert.equal(result.find(x=>x.id==="agent:eval")?.verification,"family-confirmed");
  assert.equal(result.find(x=>x.id==="agent:unknown")?.date,null);
  assert.equal(result.find(x=>x.id==="moodle:1")?.verification,"moodle-published");
  assert.ok(result.every(x=>x.student==="Luca"));
  assert.equal(result.some(x=>x.id==="agent:past"),false);
  assert.equal(result.some(x=>x.id==="moodle:2"),false);
});
test("Editorial filtering does not invent facts or fabricate absent family activity",()=>{
  const events=[item("x","Bambuddy finalizó una impresión","bambuddy"),
    item("school","Entrega de trabajo práctico","moodle",{student:"Luca",dueAt:"2026-10-11T15:00:00Z"})];
  const result=selectEditorialEvidence(events,roster,20,now);
  assert.equal(result.find(x=>x.item.id==="school")?.person,"Luca");
  assert.equal(result.some(x=>x.person==="Mariana"),false);
  assert.equal(result.some(x=>x.person==="Cruz"),false);
});
