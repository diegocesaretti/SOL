import { solPage } from "./shell.js";

export function renderSystemPage(): string {
  const body = `<section class="page">
    <div class="toolbar">
      <div>
        <div class="eyebrow">SOL · Sistema</div>
        <h1>Sistema.</h1>
        <p class="lead">Estado del núcleo, actualizaciones y herramientas avanzadas. Las actualizaciones de SOL preservan la configuración y los datos persistentes fuera de la carpeta del programa.</p>
      </div>
      <button id="check-update">Buscar actualizaciones</button>
    </div>

    <section id="core-update" class="card" style="margin-bottom:16px">
      <div class="row between"><div><div class="eyebrow">SOL Core</div><h2 style="margin-top:5px">Actualizaciones</h2></div><span class="badge"><span class="dot"></span> comprobando</span></div>
      <div class="empty" style="margin-top:14px">Consultando la versión publicada…</div>
    </section>

    <div class="grid">
      <a class="card action span4" href="/v1/inputs/plugins/extensions/ui" style="color:inherit;text-decoration:none"><div class="eyebrow">Extensiones</div><h2 style="margin-top:7px">Plugins</h2><p class="muted small">Instalar, actualizar, configurar y revisar plugins.</p></a>
      <a class="card action span4" href="/mcp" style="color:inherit;text-decoration:none"><div class="eyebrow">Herramientas</div><h2 style="margin-top:7px">MCP</h2><p class="muted small">Acceso unificado a herramientas nativas y de plugins.</p></a>
      <a class="card action span4" href="/ai" style="color:inherit;text-decoration:none"><div class="eyebrow">Razonamiento</div><h2 style="margin-top:7px">AI / Codex</h2><p class="muted small">Proveedores y runtime de razonamiento opcional.</p></a>
    </div>
  </section>`;

  const script = `
const API='/v1/inputs/plugins/core-update',root=document.getElementById('core-update'),check=document.getElementById('check-update');
const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]));
async function api(path,o={}){try{const r=await fetch(path,{cache:'no-store',...o});let b={};try{b=await r.json()}catch{}return{r,b}}catch(e){return{r:{ok:false,status:0},b:{error:e?.message||'Error de conexión'}}}}
function shortCommit(value){return value&&value!=='development'?String(value).slice(0,8):'desarrollo'}
function renderStatus(s){const installed=s.installed||{},latest=s.latest||{},manageable=!!s.canManageCoreUpdate;let state='',action='';if(s.updateAvailable){state='<span class="badge"><span class="dot warn"></span> actualización disponible</span>';if(manageable&&s.canInstall)action='<button class="primary" id="install-core-update">Actualizar ahora</button>';else if(!manageable)action='<span class="muted small">Sólo el owner puede actualizar SOL Core.</span>';else action='<span class="muted small">La instalación automática requiere el paquete portable de Windows con updater.</span>'}else{state='<span class="badge"><span class="dot good"></span> actualizado</span>';action='<span class="goodtext small">No hay una versión más nueva publicada.</span>'}root.innerHTML='<div class="row between"><div><div class="eyebrow">SOL Core</div><h2 style="margin-top:5px">Actualizaciones</h2></div>'+state+'</div><div class="grid" style="margin-top:16px"><div class="span4"><div class="label">Instalada</div><div class="stat" style="font-size:22px">v'+esc(installed.version||'—')+'</div><div class="muted micro">'+esc(shortCommit(installed.commit))+'</div></div><div class="span4"><div class="label">Publicada</div><div class="stat" style="font-size:22px">v'+esc(latest.version||'—')+'</div><div class="muted micro">'+esc(shortCommit(latest.commit))+'</div></div><div class="span4"><div class="label">Canal</div><div style="margin-top:8px"><strong>'+esc(latest.channel||'stable')+'</strong></div><div class="muted micro">'+esc(latest.publishedAt?new Date(latest.publishedAt).toLocaleString():'')+'</div></div></div><div class="divider"></div><div class="row between"><div class="muted small">El updater verifica SHA-256, conserva %LOCALAPPDATA%\\SOL y restaura la versión anterior si el nuevo build no responde en /health.</div><div class="cluster">'+action+'</div></div>';const install=document.getElementById('install-core-update');if(install)install.onclick=()=>installUpdate(install)}
async function load(force=false){check.disabled=true;check.textContent=force?'Buscando…':'Buscar actualizaciones';const out=await api(API+(force?'?force=1':''));check.disabled=false;check.textContent='Buscar actualizaciones';if(!out.r.ok){root.innerHTML='<div class="row between"><div><div class="eyebrow">SOL Core</div><h2 style="margin-top:5px">Actualizaciones</h2></div><span class="badge"><span class="dot bad"></span> sin conexión</span></div><div class="callout error" style="margin-top:14px">'+esc(out.b.error||'No se pudo comprobar la versión publicada.')+'</div>';return}renderStatus(out.b)}
async function installUpdate(btn){if(!confirm('SOL descargará la nueva versión, verificará su SHA-256, se reiniciará y hará rollback automáticamente si el nuevo build no levanta.\\n\\n¿Actualizar ahora?'))return;btn.disabled=true;btn.textContent='Preparando…';const out=await api(API+'/install',{method:'POST'});if(!out.r.ok){btn.disabled=false;btn.textContent='Actualizar ahora';alert(out.b.error||'No se pudo iniciar la actualización');return}root.innerHTML='<div class="row between"><div><div class="eyebrow">SOL Core</div><h2 style="margin-top:5px">Actualizando a v'+esc(out.b.version||'')+'</h2></div><span class="badge"><span class="dot warn"></span> reiniciando</span></div><div class="callout" style="margin-top:14px">SOL se cerrará, el updater reemplazará el paquete y volverá a iniciar. Esta página se reconectará automáticamente.</div>';waitForRestart()}
async function waitForRestart(){let sawDown=false;for(let i=0;i<90;i++){await new Promise(r=>setTimeout(r,1000));try{const r=await fetch('/health',{cache:'no-store'});if(r.ok&&sawDown){location.reload();return}if(!r.ok)sawDown=true}catch{sawDown=true}}root.innerHTML+='<div class="callout warntext" style="margin-top:12px">La UI todavía no volvió a conectar. Revisá el log del updater en %LOCALAPPDATA%\\SOL\\logs.</div>'}
check.onclick=()=>load(true);load();
`;

  return solPage("system", "Sistema", body, script);
}
