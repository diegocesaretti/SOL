export function renderLifePage(): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SOL · Vida</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:Canvas; color:CanvasText; }
    main { width:min(980px, calc(100% - 28px)); margin:auto; padding:38px 0 80px; }
    .top,.row,.tabs { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
    .top,.row { justify-content:space-between; }
    .brand { font-size:13px; font-weight:900; letter-spacing:.17em; opacity:.65; }
    nav { display:flex; gap:14px; font-size:14px; flex-wrap:wrap; }
    a { color:inherit; }
    h1 { font-size:clamp(38px,7vw,64px); letter-spacing:-.05em; margin:15px 0 7px; }
    h2 { margin:0; font-size:21px; }
    p { line-height:1.55; }
    .muted { opacity:.62; }
    .tabs { margin:24px 0 16px; }
    button { padding:10px 14px; border-radius:999px; border:1px solid color-mix(in srgb, CanvasText 18%, transparent); background:transparent; color:CanvasText; font:inherit; font-weight:800; cursor:pointer; }
    button.active { background:CanvasText; color:Canvas; }
    .card { padding:18px 20px; border:1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius:18px; margin:10px 0; }
    .meta { display:flex; gap:8px; flex-wrap:wrap; align-items:center; font-size:12px; opacity:.62; margin-top:7px; }
    .badge { border:1px solid color-mix(in srgb, CanvasText 16%, transparent); padding:4px 7px; border-radius:999px; }
    .body { white-space:pre-wrap; overflow-wrap:anywhere; opacity:.82; margin:10px 0 0; }
    .entity-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    .fact { padding:8px 0; border-top:1px solid color-mix(in srgb, CanvasText 9%, transparent); font-size:13px; }
    .fact:first-child { border-top:0; }
    .empty { padding:38px 10px; text-align:center; opacity:.6; }
    .more { margin-top:18px; }
    @media(max-width:680px){ main{padding-top:28px}.entity-grid{grid-template-columns:1fr}.top{align-items:flex-start} }
  </style>
</head>
<body><main>
  <div class="top"><div class="brand">SOL · VIDA</div><nav><a href="/">Inicio</a><a href="/executive">Día a día</a><a href="/sol-whatsapp">WhatsApp de SOL</a></nav></div>
  <h1>Lo que SOL sabe.</h1>
  <p class="muted">Timeline y conocimiento visible para tu perfil. Los registros privados de otros miembros no se recuperan para construir esta pantalla.</p>
  <div class="tabs"><button class="active" data-tab="timeline">Timeline</button><button data-tab="people">Personas</button><button data-tab="projects">Proyectos</button></div>
  <section id="content"><p class="empty">Cargando…</p></section>
</main>
<script>
  const content=document.getElementById('content');
  let current='timeline', nextBefore;
  function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]));}
  async function api(path){const r=await fetch(path,{cache:'no-store'});let b={};try{b=await r.json()}catch{};return{r,b};}
  function when(v){try{return new Intl.DateTimeFormat('es-AR',{dateStyle:'medium',timeStyle:'short'}).format(new Date(v))}catch{return v}}
  function visibility(v){return ({private:'privado',family:'familia',shared:'compartido',project:'proyecto',system:'sistema'})[v]||v;}
  function itemLabel(i){return i.type==='task'?'Tarea':i.type==='event'?'Evento':(i.provider==='whatsapp'?'WhatsApp':i.provider||'Fuente');}
  function timelineCard(i){return '<article class="card"><div class="row"><h2>'+esc(i.title)+'</h2><span class="badge">'+esc(itemLabel(i))+'</span></div>'+(i.summary?'<div class="body">'+esc(i.summary)+'</div>':'')+'<div class="meta"><span>'+esc(when(i.occurredAt))+'</span><span class="badge">'+esc(visibility(i.visibility))+'</span>'+(i.sourceLabel?'<span>'+esc(i.sourceLabel)+'</span>':'')+'</div></article>';}
  async function loadTimeline(append=false){
    if(!append){content.innerHTML='<p class="empty">Cargando timeline…</p>';nextBefore=undefined;}
    const q=new URLSearchParams({limit:'60'}); if(append&&nextBefore)q.set('before',nextBefore);
    const out=await api('/v1/life/timeline?'+q);
    if(!out.r.ok){content.innerHTML='<p class="empty">'+esc(out.b.error||'No se pudo cargar')+'</p>';return;}
    const html=(out.b.items||[]).map(timelineCard).join('');
    if(!append) content.innerHTML=html||'<p class="empty">Todavía no hay elementos visibles en tu timeline.</p>';
    else {const old=document.getElementById('more');if(old)old.remove();content.insertAdjacentHTML('beforeend',html);}
    nextBefore=out.b.nextBefore;
    if(nextBefore){content.insertAdjacentHTML('beforeend','<button id="more" class="more">Cargar anteriores</button>');document.getElementById('more').onclick=()=>loadTimeline(true);}
  }
  function valueText(v){if(v===undefined||v===null)return ''; if(typeof v==='string')return v; try{return JSON.stringify(v)}catch{return String(v)}}
  function entityCard(e){const aliases=(e.aliases||[]).length?'<div class="meta">También: '+esc(e.aliases.join(', '))+'</div>':'';const facts=(e.facts||[]).slice(0,8).map(f=>'<div class="fact"><strong>'+esc(f.predicate)+'</strong>: '+esc(valueText(f.value)||f.objectEntityId||'—')+'</div>').join('');return '<article class="card"><div class="row"><h2>'+esc(e.name)+'</h2><span class="badge">'+esc(visibility(e.visibility))+'</span></div>'+aliases+(facts?'<div style="margin-top:12px">'+facts+'</div>':'<p class="muted">Sin hechos consolidados todavía.</p>')+'</article>';}
  async function loadEntities(kind){content.innerHTML='<p class="empty">Cargando…</p>';const out=await api('/v1/knowledge/entities?kind='+kind);if(!out.r.ok){content.innerHTML='<p class="empty">'+esc(out.b.error||'No se pudo cargar')+'</p>';return;}const entities=out.b.entities||[];content.innerHTML=entities.length?'<div class="entity-grid">'+entities.map(entityCard).join('')+'</div>':'<p class="empty">SOL todavía no consolidó '+(kind==='person'?'personas':'proyectos')+' visibles para vos.</p>';}
  async function select(tab){current=tab;document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));if(tab==='timeline')await loadTimeline();else await loadEntities(tab==='people'?'person':'project');}
  document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>select(b.dataset.tab));
  select('timeline');
</script></body></html>`;
}
