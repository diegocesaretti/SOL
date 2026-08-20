import { solPage } from "./shell.js";

export function renderOutputsPage(): string {
  const body = `<section class="page">
    <div class="eyebrow">SOL · Outputs</div>
    <h1>Lo que SOL puede hacer.</h1>
    <p class="lead">Outputs reúne destinos de comunicación y acción. Leer una fuente no habilita escribir en ella: cada capacidad de salida se configura y audita por separado.</p>
    <div id="summary" class="grid" style="margin-bottom:16px">
      <div class="card span4"><div class="stat">—</div><div class="label">outputs disponibles</div></div>
      <div class="card span4"><div class="stat">—</div><div class="label">activos</div></div>
      <div class="card span4"><div class="stat">—</div><div class="label">acciones pendientes</div></div>
    </div>
    <section id="outputs"><div class="empty">Cargando outputs…</div></section>
  </section>`;

  const script = `
const root=document.getElementById('outputs'),summary=document.getElementById('summary');
const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]));
async function api(path,o={}){const c=new AbortController(),t=setTimeout(()=>c.abort(),12000);try{const r=await fetch(path,{cache:'no-store',...o,signal:c.signal});let b={};try{b=await r.json()}catch{}return{r,b}}catch(e){return{r:{ok:false,status:0},b:{error:e?.name==='AbortError'?'Tiempo de espera agotado':e?.message||'Error de conexión'}}}finally{clearTimeout(t)}}
function badge(state){const good=['open','connected','ready','configured'].includes(state),warn=['connecting','reconnecting','qr','pending'].includes(state),dot=good?'good':warn?'warn':state==='disabled'?'':'bad';return '<span class="badge"><span class="dot '+dot+'"></span>'+esc(state)+'</span>'}
function outputCard(icon,title,subtitle,state,body,actions){return '<article class="card" style="margin-bottom:12px"><div class="row between"><div class="cluster"><div style="width:38px;height:38px;border-radius:12px;background:#202632;display:grid;place-items:center;font-weight:900">'+esc(icon)+'</div><div><h2>'+esc(title)+'</h2><div class="small muted">'+esc(subtitle)+'</div></div></div>'+badge(state)+'</div>'+(body?'<div style="margin-top:14px;line-height:1.5">'+body+'</div>':'')+(actions?'<div class="cluster" style="margin-top:16px">'+actions+'</div>':'')+'</article>'}
async function calendarTargets(accounts){const targets=[];for(const a of accounts){const out=await api('/v1/calendar/accounts/'+encodeURIComponent(a.id)+'/calendars');if(!out.r.ok)continue;for(const c of out.b.calendars||[])if(c.selectedForWrite)targets.push({account:a,calendar:c})}return targets}
async function load(){const [me,solwa,cal,proposals]=await Promise.all([api('/v1/auth/me'),api('/v1/sol-whatsapp'),api('/v1/calendar/accounts'),api('/v1/executive/proposals?status=pending')]);if(!me.r.ok){root.innerHTML='<div class="empty">Necesitás iniciar sesión.</div>';return}const accounts=cal.r.ok?(cal.b.accounts||[]):[],targets=await calendarTargets(accounts),pending=proposals.r.ok?(proposals.b.proposals||[]):[];const cards=[];let active=0;
const wa=solwa.r.ok?solwa.b.account:null,waState=wa?.runtime?.state||'no configurado';if(waState==='open')active++;cards.push(outputCard('W','WhatsApp de SOL','Canal de respuestas, briefs y aprobaciones',waState,wa?'<div class="small muted">'+esc(wa.runtime?.displayName||wa.label||'Cuenta vinculada')+(solwa.b.binding?' · tu WhatsApp está vinculado':' · tu miembro todavía no está vinculado')+'</div>':'<div class="muted">Todavía no existe la cuenta de WhatsApp dedicada a SOL.</div>','<a class="button" href="/sol-whatsapp?advanced=1">Configurar WhatsApp de SOL</a>'));
const calState=targets.length?'configured':'sin destino';if(targets.length)active++;cards.push(outputCard('C','Google Calendar · escritura','Sólo calendarios elegidos explícitamente como destino',calState,targets.length?targets.map(t=>'<div class="feeditem"><strong>'+esc(t.calendar.summary)+'</strong><div class="small muted">'+esc(t.account.label)+(t.account.googleEmail?' · '+esc(t.account.googleEmail):'')+'</div></div>').join(''):'<div class="muted">Podés leer calendarios como Input sin permitir escritura. Elegí un único destino de escritura cuando quieras que SOL cree eventos aprobados.</div>','<a class="button" href="/calendar?advanced=1">Configurar destino Calendar</a>'));
const execState=pending.length?'pending':'ready';active++;cards.push(outputCard('✓','Executive','Guardia de permisos y aprobaciones',execState,'<div><strong>'+pending.length+'</strong> propuesta(s) pendientes. Toda acción externa sigue pasando por permisos, aprobación cuando corresponde y action_log.</div>','<a class="button" href="/executive?advanced=1">Abrir cola de acciones</a>'));
cards.push(outputCard('H','Home Assistant · control','Output futuro; hoy Home Assistant es sólo Input','disabled','<div class="muted">Los estados seleccionados se pueden leer, pero SOL todavía no puede llamar servicios ni controlar dispositivos.</div>','<a class="button" href="/inputs">Ver Home Assistant en Inputs</a>'));
cards.push(outputCard('M','Mercado Libre · escritura','Output futuro; hoy Mercado Libre es sólo Input','disabled','<div class="muted">SOL puede leer ventas, publicaciones y preguntas, pero todavía no responde ni modifica stock/precio/publicaciones.</div>','<a class="button" href="/inputs">Ver Mercado Libre en Inputs</a>'));
summary.innerHTML='<div class="card span4"><div class="stat">5</div><div class="label">outputs modelados</div></div><div class="card span4"><div class="stat">'+active+'</div><div class="label">activos/configurados</div></div><div class="card span4"><div class="stat">'+pending.length+'</div><div class="label">acciones pendientes</div></div>';root.innerHTML=cards.join('')}
load();setInterval(()=>{if(!document.hidden)load().catch(()=>{})},15000);
`;
  return solPage("outputs", "Outputs", body, script);
}
