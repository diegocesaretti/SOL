import { solPage } from "./shell.js";

/**
 * Contextual, read-only panorama. All requests inherit the logged-in user's
 * authorization and their server-side visibility scopes. No data is embedded
 * into the HTML, and no writes/actions are issued from this screen.
 */
export function renderPanoramaPage(): string {
  const body = `
<section class="page panorama-page">
  <div class="pan-top">
    <div>
      <div class="eyebrow">SOL · Panorama contextual</div>
      <h1>Lo importante, antes de preguntar.</h1>
      <p class="lead">Un vistazo a lo que SOL observa, recuerda y puede anticipar. Cada señal se explica con su origen.</p>
    </div>
    <div class="cluster pan-actions"><span class="pan-freshness" id="pan-updated" role="status">Cargando datos…</span><button id="pan-refresh">↻ Actualizar</button></div>
  </div>

  <nav class="pan-filters" aria-label="Filtrar señales según origen">
    <button class="active" data-scope="all" aria-pressed="true">Todo</button>
    <button data-scope="home" aria-pressed="false">Hogar</button>
    <button data-scope="work" aria-pressed="false">Producción</button>
    <button data-scope="family" aria-pressed="false">Familia</button>
    <span class="pan-filter-help">Filtros por fuente, no por contenido privado.</span>
  </nav>

  <section class="pan-metrics" id="pan-metrics" aria-label="Indicadores principales">
    <div class="pan-metric"><div class="pan-value">—</div><div class="pan-label">Fuentes</div></div>
    <div class="pan-metric"><div class="pan-value">—</div><div class="pan-label">Actividad reciente</div></div>
    <div class="pan-metric"><div class="pan-value">—</div><div class="pan-label">Señales</div></div>
    <div class="pan-metric"><div class="pan-value">—</div><div class="pan-label">Conocimiento</div></div>
  </section>

  <div class="pan-layout">
    <div class="pan-main">
      <section class="pan-panel">
        <header class="pan-heading"><div><div class="kicker">Atención</div><h2>Lo que merece una mirada</h2></div><span class="pan-count" id="pan-attention-count">—</span></header>
        <div id="pan-attention" aria-live="polite"><div class="pan-empty">Buscando señales verificables…</div></div>
      </section>
      <section class="pan-panel">
        <header class="pan-heading"><div><div class="kicker">Actividad / Evidencia</div><h2>Qué ocurrió</h2></div><a href="/life">Explorar Life ↗</a></header>
        <div id="pan-activity"><div class="pan-empty">Consultando la línea de tiempo…</div></div>
      </section>
    </div>
    <aside class="pan-side">
      <section class="pan-panel pan-forecast">
        <header class="pan-heading"><div><div class="kicker">Horizonte: próximas 72 horas</div><h2>Señales anticipadas</h2></div></header>
        <p class="pan-help">Sólo mostramos fechas futuras cuando existe un vencimiento estructurado. Ninguna inferencia se presenta como certeza.</p>
        <div id="pan-forecast"><div class="pan-empty">Analizando fechas con evidencia…</div></div>
      </section>
      <section class="pan-panel">
        <header class="pan-heading"><div><div class="kicker">Memoria navegable</div><h2>Lo que SOL conoce</h2></div><a href="/life">Ver conocimiento ↗</a></header>
        <div id="pan-knowledge"><div class="pan-empty">Consultando entidades…</div></div>
      </section>
      <section class="pan-panel pan-privacy">
        <div class="kicker">Cómo interpretar SOL</div>
        <div class="pan-legend"><span class="pan-dot observed"></span><div><strong>Observado</strong><small>Información devuelta por una fuente</small></div></div>
        <div class="pan-legend"><span class="pan-dot signal"></span><div><strong>Señal</strong><small>Priorización de una observación; revisar evidencia</small></div></div>
        <div class="pan-legend"><span class="pan-dot future"></span><div><strong>Anticipado</strong><small>Fecha explícita, no pronóstico estadístico</small></div></div>
        <p class="pan-help">SOL respeta los permisos de tu sesión. Esta pantalla es de solo lectura: no ejecuta acciones.</p>
      </section>
    </aside>
  </div>
</section>`;

  const styles = `<style>
.panorama-page{max-width:1400px}
.pan-top{display:flex;gap:22px;justify-content:space-between;align-items:start;margin-bottom:22px}
.pan-top h1{max-width:810px;font-size:clamp(36px,4.2vw,58px)}
.pan-top .lead{max-width:700px}
.pan-actions{flex-shrink:0;margin-top:10px}
.pan-freshness{font-size:12px;color:var(--muted)}
.pan-filters{display:flex;align-items:center;flex-wrap:wrap;gap:9px;margin:0 0 18px}
.pan-filters button{border-radius:999px;padding:9px 15px}
.pan-filters button.active{background:rgba(160,212,246,.18);border-color:rgba(200,239,255,.38);color:var(--text)}
.pan-filter-help{font-size:11px;color:var(--muted);margin-left:6px}
.pan-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:20px}
.pan-metric,.pan-panel{border:1px solid var(--glass-line,var(--line));background:linear-gradient(145deg,rgba(200,233,255,.10),rgba(128,170,217,.035));border-radius:20px;box-shadow:0 10px 32px rgba(0,0,0,.10);backdrop-filter:blur(18px)}
.pan-metric{padding:18px 20px;min-width:0}.pan-value{font-size:clamp(23px,3vw,36px);font-weight:750;letter-spacing:-.06em;line-height:1.2}.pan-label{font-size:12px;color:var(--muted);margin-top:6px}
.pan-layout{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(305px,1fr);gap:16px}.pan-main,.pan-side{display:grid;gap:16px;align-content:start;min-width:0}
.pan-panel{padding:19px 20px;min-width:0}.pan-heading{display:flex;justify-content:space-between;gap:13px;align-items:center;padding:0 0 14px}
.pan-heading .kicker{margin-bottom:6px}.pan-heading h2{font-size:19px}.pan-heading a,.pan-text-link{color:#b3e6ff;font-size:12px;text-decoration:none;font-weight:650}.pan-heading a:hover,.pan-text-link:hover{text-decoration:underline}
.pan-count{font-size:11px;border:1px solid var(--line);border-radius:50px;padding:4px 9px;color:var(--muted)}
.pan-item{padding:13px 0;border-top:1px solid rgba(215,237,255,.11);display:grid;grid-template-columns:36px minmax(0,1fr);gap:12px}
.pan-item:first-child{border-top:0}.pan-icon{height:34px;width:34px;border:1px solid rgba(226,243,255,.2);background:rgba(255,255,255,.055);display:grid;place-items:center;border-radius:11px;font-size:14px}
.pan-line{display:flex;align-items:baseline;justify-content:space-between;gap:8px}.pan-line strong{font-size:13px;font-weight:720;line-height:1.45;overflow-wrap:anywhere}.pan-when{color:var(--muted);font-size:11px;white-space:nowrap}
.pan-description{color:#b2bfd0;font-size:12px;line-height:1.5;margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere}
.pan-meta{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px;align-items:center}.pan-tag{font-size:10px;color:#c6d6e8;border:1px solid rgba(219,241,255,.16);padding:3px 8px;border-radius:99px}
.pan-tag.alert{color:#ffdcaa;border-color:rgba(255,220,170,.3)}.pan-tag.future{color:#b7eedc;border-color:rgba(158,235,193,.3)}
.pan-empty{padding:16px 2px;color:var(--muted);font-size:13px;line-height:1.6}.pan-error{color:#ffabb1}
.pan-help{font-size:12px;line-height:1.65;color:var(--muted);margin:0 0 11px}.pan-legend{display:flex;gap:10px;align-items:start;margin:12px 0}.pan-legend strong{display:block;font-size:12px}.pan-legend small{display:block;font-size:11px;color:var(--muted);margin-top:3px}
.pan-dot{border-radius:50%;width:8px;height:8px;flex:none;margin-top:5px}.pan-dot.observed{background:#75cfff}.pan-dot.signal{background:#ffca87}.pan-dot.future{background:#7de5b5}.pan-privacy .pan-help{margin:15px 0 0}
@media(max-width:1050px){.pan-layout{grid-template-columns:minmax(0,1fr)}.pan-side{grid-template-columns:repeat(2,minmax(0,1fr))}.pan-side .pan-privacy{grid-column:1/-1}.pan-top{flex-wrap:wrap}}
@media(max-width:680px){.pan-top{display:block}.pan-actions{margin:0 0 20px}.pan-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.pan-side{grid-template-columns:1fr}.pan-side .pan-privacy{grid-column:auto}.pan-panel{padding:15px}.pan-filter-help{width:100%;margin:0}.pan-line{flex-wrap:wrap}.pan-when{white-space:normal}.pan-metric{padding:15px}}
@media(prefers-reduced-motion:reduce){.pan-metric,.pan-panel{scroll-behavior:auto}}
</style>`;

  const script = `
(()=>{
  'use strict';
  const byId=id=>document.getElementById(id);
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const niceTime=v=>{const d=new Date(v);return Number.isFinite(d.getTime())?d.toLocaleString('es-AR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}):'sin fecha'};
  const clip=(v,n=205)=>{const s=String(v||'');return s.length>n?s.slice(0,n).trimEnd()+'…':s};
  const provider=p=>({whatsapp:'WhatsApp',mcp:'SOL MCP',home_assistant:'Home Assistant',mercadolibre:'Mercado Libre',bambuddy:'Bambuddy',gmail:'Gmail',google_calendar:'Calendar'})[p]||p||'SOL';
  const statusGood=s=>['connected','open','running','ready'].includes(String(s||'').toLowerCase());
  const scopeProvider=(p,s)=>{
    if(s==='all')return true;
    const v=String(p||'').toLowerCase();
    if(s==='home')return /home.assistant|climate|hass/.test(v);
    if(s==='work')return /bambu|mercado|bwa|printer/.test(v);
    if(s==='family')return /whatsapp|gmail|calendar/.test(v);
    return false;
  };
  let state={scope:'all',requests:{},inputs:[],plugins:[],timeline:[],people:[],projects:[],refreshing:false};
  async function api(path){
    const ctrl=new AbortController(), timer=setTimeout(()=>ctrl.abort(),12000);
    try {
      const r=await fetch(path,{cache:'no-store',credentials:'same-origin',signal:ctrl.signal});
      let body={};try{body=await r.json()}catch{}
      return {ok:r.ok,status:r.status,data:body,error:body.error};
    } catch(e){return {ok:false,status:0,error:e?.name==='AbortError'?'La consulta agotó su tiempo':'Conexión no disponible'};}
    finally{clearTimeout(timer);}
  }
  function item(title,description,source,time,kind,url){
    const tag=kind==='future'?'Anticipado':kind==='signal'?'Señal':'Observado';
    return '<article class="pan-item"><div class="pan-icon" aria-hidden="true">'+(kind==='future'?'◷':kind==='signal'?'!':'•')+'</div><div><div class="pan-line"><strong>'+esc(title)+'</strong><span class="pan-when">'+esc(time||'')+'</span></div>'+
      (description?'<div class="pan-description">'+esc(clip(description))+'</div>':'')+
      '<div class="pan-meta"><span class="pan-tag '+(kind==='signal'?'alert':kind==='future'?'future':'')+'">'+tag+'</span><span class="pan-tag">'+esc(source)+'</span>'+
      (url?'<a class="pan-text-link" href="'+esc(url)+'">Ver evidencia ↗</a>':'')+'</div></div></article>';
  }
  function filteredTimeline(){
    return state.timeline.filter(i=>scopeProvider(i.provider,state.scope));
  }
  function filteredInputs(){
    return state.inputs.filter(i=>scopeProvider(i.provider||i.pluginId||i.authMode,state.scope));
  }
  function filteredPlugins(){
    return state.plugins.filter(p=>scopeProvider(p.manifest?.id||p.manifest?.name,state.scope));
  }
  function renderMetrics(){
    const input=filteredInputs(),events=filteredTimeline(),signal=events.filter(i=>i.metadata?.intelligencePriority==='high'),known=state.people.length+state.projects.length;
    const sourceVal=state.requests.inputs?.ok?input.length:'—';
    const eventVal=state.requests.timeline?.ok?events.length:'—';
    const signalVal=state.requests.timeline?.ok?signal.length:'—';
    const knownVal=state.requests.people?.ok&&state.requests.projects?.ok?known:'—';
    byId('pan-metrics').innerHTML=[
      [sourceVal,'Fuentes visibles'],[eventVal,'Eventos consultados'],[signalVal,'Señales de alta prioridad'],[knownVal,'Entidades conocidas']
    ].map(x=>'<div class="pan-metric"><div class="pan-value">'+esc(x[0])+'</div><div class="pan-label">'+esc(x[1])+'</div></div>').join('');
  }
  function renderAttention(){
    const alerts=[];
    if(state.requests.plugins?.ok){
      for(const p of filteredPlugins()){
        if(p.state==='error'||p.health==='unhealthy'||p.health==='degraded'){
          alerts.push({title:'Revisar '+(p.manifest?.name||'plugin'),desc:'Estado reportado: '+(p.health||p.state)+'. Podría limitar las capacidades asociadas.',src:'Runtime de plugin',kind:'signal',url:'/v1/inputs/plugins/extensions/ui',time:''});
        }
      }
    }
    if(state.requests.inputs?.ok){
      for(const i of filteredInputs()){
        if(['error','disconnected'].includes(String(i.status||'').toLowerCase())){
          alerts.push({title:'Conexión con problemas: '+(i.label||i.provider||'Fuente'),desc:'Estado informado: '+i.status+'. Si sigue desconectada, podrían faltar nuevas observaciones.',src:'Conexiones · '+provider(i.provider),kind:'signal',url:'/inputs',time:''});
        }
      }
    }
    if(state.requests.timeline?.ok){
      for(const e of filteredTimeline().filter(i=>i.metadata?.intelligencePriority==='high').slice(0,7)){
        alerts.push({title:e.title||'Señal de alta prioridad',desc:e.summary||'El sistema marcó esta entrada para revisar. No constituye una decisión automática.',src:provider(e.provider)+(e.sourceLabel?' · '+e.sourceLabel:''),kind:'signal',url:'/life',time:niceTime(e.occurredAt)});
      }
    }
    byId('pan-attention-count').textContent=String(alerts.length);
    const section=byId('pan-attention');
    if(!state.requests.plugins?.ok&&!state.requests.inputs?.ok&&!state.requests.timeline?.ok){
      section.innerHTML='<div class="pan-empty pan-error">No se pudo verificar el estado de las fuentes. <a href="/">Iniciar sesión o volver a intentar</a>.</div>';return;
    }
    section.innerHTML=alerts.length?alerts.slice(0,9).map(a=>item(a.title,a.desc,a.src,a.time,a.kind,a.url)).join(''):
      '<div class="pan-empty">No encontré alertas verificables entre las fuentes consultadas. Esto no garantiza que todos los servicios estén funcionando.</div>';
  }
  function renderActivity(){
    if(!state.requests.timeline?.ok){byId('pan-activity').innerHTML='<div class="pan-empty pan-error">No se pudo consultar Life. Verificá tu sesión o conexión.</div>';return}
    const ev=filteredTimeline().slice().sort((a,b)=>new Date(b.occurredAt||0)-new Date(a.occurredAt||0)).slice(0,8);
    byId('pan-activity').innerHTML=ev.length?ev.map(e=>item(e.title||'Actividad',e.summary||'',provider(e.provider)+(e.sourceLabel?' · '+e.sourceLabel:''),niceTime(e.occurredAt),'observed','/life')).join(''):
      '<div class="pan-empty">Todavía no hay eventos accesibles para este filtro. Probá Todo o revisá las fuentes de entrada.</div>';
  }
  function dueDate(e){
    // Only structured task due-dates: never parse ambiguous free-form messages.
    if(e.type!=='task'||!e.metadata)return null;
    const raw=e.metadata.dueAt??e.metadata.dueDate;
    if(typeof raw!=='string'||!/^\\d{4}-\\d{2}-\\d{2}(T.*)?$/.test(raw))return null;
    const date=new Date(raw);
    return Number.isFinite(date.getTime())?date:null;
  }
  function renderForecast(){
    if(!state.requests.timeline?.ok){byId('pan-forecast').innerHTML='<div class="pan-empty">No hay una fuente de fechas disponible en este momento.</div>';return}
    const now=Date.now(),end=now+72*3600*1000;
    const events=filteredTimeline().map(e=>({e,date:dueDate(e)})).filter(x=>x.date&&x.date.getTime()>=now&&x.date.getTime()<=end).sort((a,b)=>a.date-b.date).slice(0,5);
    byId('pan-forecast').innerHTML=events.length?events.map(x=>item(x.e.title||'Tarea con vencimiento','Se acerca un vencimiento explícito en los datos de la tarea. Confirmá la fecha en su fuente.',provider(x.e.provider),niceTime(x.date),'future','/life')).join(''):
      '<div class="pan-empty">No hay vencimientos estructurados verificables en las próximas 72 horas dentro de los datos consultados.<p class="pan-help" style="margin-top:8px">Próxima etapa: previsiones basadas en series históricas y reglas validadas, con explicación y confianza calibrada.</p></div>';
  }
  function renderKnowledge(){
    if(!state.requests.people?.ok&&!state.requests.projects?.ok){byId('pan-knowledge').innerHTML='<div class="pan-empty">No fue posible acceder al conocimiento de esta sesión.</div>';return}
    const entities=state.people.concat(state.projects).sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'es')).slice(0,7);
    byId('pan-knowledge').innerHTML=entities.length?entities.map(e=>item(e.name||'Entidad','Hechos registrados: '+(e.facts||[]).length+' · Alcance: '+(e.visibility||'desconocido'),e.kind==='project'?'Proyecto':'Persona','', 'observed','/life')).join(''):
      '<div class="pan-empty">Aún no hay personas o proyectos registrados como entidades durables accesibles. La actividad de Life no equivale automáticamente a memoria consolidada.</div>';
  }
  function render(){renderMetrics();renderAttention();renderActivity();renderForecast();renderKnowledge();}
  async function load(){
    if(state.refreshing)return;
    state.refreshing=true;const btn=byId('pan-refresh');btn.disabled=true;btn.textContent='Actualizando…';
    const paths={auth:'/v1/auth/me',inputs:'/v1/inputs',plugins:'/v1/inputs/plugins',timeline:'/v1/life/timeline?limit=80',people:'/v1/knowledge/entities?kind=person',projects:'/v1/knowledge/entities?kind=project'};
    const pairs=await Promise.all(Object.entries(paths).map(async ([k,p])=>[k,await api(p)]));
    state.requests=Object.fromEntries(pairs);
    if(state.requests.auth?.status===401){
      byId('pan-updated').textContent='Iniciá sesión para consultar tus datos';
      byId('pan-attention').innerHTML='<div class="pan-empty">Tu sesión no está activa. <a class="pan-text-link" href="/">Entrar a SOL ↗</a></div>';
      byId('pan-activity').innerHTML='';byId('pan-forecast').innerHTML='';byId('pan-knowledge').innerHTML='';
    }else{
      state.inputs=state.requests.inputs?.ok?state.requests.inputs.data.inputs||[]:[];
      state.plugins=state.requests.plugins?.ok?state.requests.plugins.data.plugins||[]:[];
      state.timeline=state.requests.timeline?.ok?state.requests.timeline.data.items||[]:[];
      state.people=state.requests.people?.ok?state.requests.people.data.entities||[]:[];
      state.projects=state.requests.projects?.ok?state.requests.projects.data.entities||[]:[];
      render();
      const errors=Object.entries(state.requests).filter(([k,v])=>k!=='auth'&&!v.ok).length;
      byId('pan-updated').textContent=niceTime(new Date())+(errors?' · '+errors+' fuentes no disponibles':' · consultas realizadas');
    }
    state.refreshing=false;btn.disabled=false;btn.textContent='↻ Actualizar';
  }
  document.querySelectorAll('[data-scope]').forEach(b=>b.addEventListener('click',()=>{
    state.scope=b.dataset.scope;
    document.querySelectorAll('[data-scope]').forEach(x=>{const on=x===b;x.classList.toggle('active',on);x.setAttribute('aria-pressed',String(on));});
    if(state.requests.auth?.status!==401)render();
  }));
  byId('pan-refresh').addEventListener('click',load);
  load();
  // Lightweight refresh; never poll while the view is hidden.
  setInterval(()=>{if(!document.hidden)load();},60000);
})();
`;
  return solPage("home", "Panorama contextual", body, script, styles);
}
