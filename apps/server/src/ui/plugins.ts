import { solPage } from "./shell.js";

export function renderPluginsPage(): string {
  const body = `<section class="page">
    <div class="toolbar">
      <div>
        <div class="eyebrow">SOL · Servicios</div>
        <h1>Plugins.</h1>
        <p class="lead">Instalá y administrá módulos de SOL desde un solo lugar. Cada plugin corre en un proceso separado; SOL supervisa su estado, reinicios y logs.</p>
      </div>
      <div class="cluster"><input id="package" type="file" accept=".solplugin,application/zip" hidden><button class="primary" id="install">+ Instalar .solplugin</button></div>
    </div>
    <div class="card soft small" style="margin-bottom:16px"><strong>MVP de plugins.</strong> Instalá únicamente paquetes que confíes. Firma criptográfica de paquetes y sandbox de permisos quedan para la siguiente etapa.</div>
    <div id="summary" class="grid" style="margin-bottom:16px"></div>
    <section id="plugins"><div class="empty">Cargando servicios…</div></section>
    <dialog id="logs-dialog"><div class="dialogbody"><div class="dialoghead"><div><div class="eyebrow">Plugin logs</div><h2 id="logs-title">Logs</h2></div><button id="logs-close">✕</button></div><pre id="logs" style="white-space:pre-wrap;max-height:60vh;overflow:auto;background:#0d1015;border:1px solid var(--line);border-radius:12px;padding:14px"></pre></div></dialog>
  </section>`;

  const script = `
const API='/v1/inputs/plugins';
const root=document.getElementById('plugins'),summary=document.getElementById('summary'),pick=document.getElementById('package'),install=document.getElementById('install'),dlg=document.getElementById('logs-dialog'),logs=document.getElementById('logs');
const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]));
async function api(path,o={}){try{const r=await fetch(path,{cache:'no-store',...o});let b={};try{b=await r.json()}catch{}return{r,b}}catch(e){return{r:{ok:false,status:0},b:{error:e?.message||'Error de conexión'}}}}
function badge(p){const cls=p.state==='running'?(p.health==='unhealthy'?'bad':p.health==='degraded'?'warn':'good'):p.state==='starting'?'warn':p.state==='error'?'bad':'';const label=p.state==='running'?(p.health==='unknown'?'ejecutando':p.health):p.state;return '<span class="badge"><span class="dot '+cls+'"></span>'+esc(label)+'</span>'}
function tokens(items){return (items||[]).length?items.map(x=>'<span class="badge">'+esc(x)+'</span>').join(' '):'<span class="muted small">ninguno</span>'}
function card(p,canManage){const m=p.manifest,run=p.state==='running'||p.state==='starting';return '<article class="card" style="margin-bottom:12px"><div class="row between"><div><div class="eyebrow">'+esc(m.id)+' · v'+esc(m.version)+'</div><h2 style="margin-top:5px">'+esc(m.name)+'</h2><p class="muted" style="margin:7px 0 0">'+esc(m.description||'Plugin de SOL')+'</p></div>'+badge(p)+'</div><div class="grid" style="margin-top:16px"><div class="span4"><div class="label">Runtime</div><div style="margin-top:5px"><strong>'+esc(m.runtime)+'</strong></div></div><div class="span4"><div class="label">PID</div><div style="margin-top:5px"><strong>'+esc(p.pid||'—')+'</strong></div></div><div class="span4"><div class="label">Autostart</div><div style="margin-top:5px"><strong>'+(p.enabled?'sí':'no')+'</strong></div></div></div><div class="divider"></div><div class="small"><div class="label">Capabilities</div><div class="cluster" style="margin-top:6px">'+tokens(m.capabilities)+'</div><div class="label" style="margin-top:12px">Permisos declarados</div><div class="cluster" style="margin-top:6px">'+tokens(m.permissions)+'</div></div>'+(p.lastError?'<div class="card soft error small" style="margin-top:14px">'+esc(p.lastError)+'</div>':'')+(canManage?'<div class="cluster" style="margin-top:16px">'+(run?'<button data-action="stop" data-id="'+esc(m.id)+'">Detener</button>':'<button class="primary" data-action="start" data-id="'+esc(m.id)+'">Iniciar</button>')+'<button data-action="restart" data-id="'+esc(m.id)+'">Reiniciar</button><button data-logs="'+esc(m.id)+'">Logs</button><button class="danger" data-remove="'+esc(m.id)+'">Desinstalar</button></div>':'')+'</article>'}
let canManage=false;
async function load(){const out=await api(API);if(!out.r.ok){root.innerHTML='<div class="empty error">'+esc(out.b.error||'No se pudieron cargar los plugins')+'</div>';return}const list=out.b.plugins||[];canManage=!!out.b.canManage;install.style.display=canManage?'':'none';const running=list.filter(x=>x.state==='running').length,healthy=list.filter(x=>x.health==='healthy').length;summary.innerHTML='<div class="card span4"><div class="stat">'+list.length+'</div><div class="label">plugins instalados</div></div><div class="card span4"><div class="stat">'+running+'</div><div class="label">ejecutándose</div></div><div class="card span4"><div class="stat">'+healthy+'</div><div class="label">saludables</div></div>';root.innerHTML=list.length?list.map(x=>card(x,canManage)).join(''):'<div class="empty">No hay plugins instalados todavía.</div>';bind()}
function bind(){document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>action(b.dataset.id,b.dataset.action));document.querySelectorAll('[data-logs]').forEach(b=>b.onclick=()=>showLogs(b.dataset.logs));document.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>removePlugin(b.dataset.remove))}
async function action(id,actionName){const out=await api(API+'/'+encodeURIComponent(id)+'/'+actionName,{method:'POST'});if(!out.r.ok)alert(out.b.error||'No se pudo actualizar el plugin');await load()}
async function removePlugin(id){if(!confirm('¿Desinstalar '+id+'? Se eliminarán los archivos del plugin.'))return;const out=await api(API+'/'+encodeURIComponent(id),{method:'DELETE'});if(!out.r.ok)alert(out.b.error||'No se pudo desinstalar');await load()}
async function showLogs(id){document.getElementById('logs-title').textContent=id;logs.textContent='Cargando…';dlg.showModal();const out=await api(API+'/'+encodeURIComponent(id)+'/logs?limit=300');logs.textContent=out.r.ok?(out.b.logs||[]).map(x=>'['+x.at+'] '+x.level.toUpperCase()+' '+x.stream+' · '+x.message).join('\\n'):(out.b.error||'Error')}
document.getElementById('logs-close').onclick=()=>dlg.close();install.onclick=()=>pick.click();pick.onchange=async()=>{const file=pick.files?.[0];if(!file)return;if(!file.name.toLowerCase().endsWith('.solplugin')){alert('Seleccioná un archivo .solplugin');pick.value='';return}install.disabled=true;install.textContent='Instalando…';const out=await api(API+'/install',{method:'POST',headers:{'content-type':'application/octet-stream','x-sol-plugin-filename':file.name},body:file});install.disabled=false;install.textContent='+ Instalar .solplugin';pick.value='';if(!out.r.ok){alert(out.b.error||'No se pudo instalar');return}await load()};
load();setInterval(()=>{if(!document.hidden)load()},5000);
`;
  return solPage("plugins", "Servicios", body, script);
}
