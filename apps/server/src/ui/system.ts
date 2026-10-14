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

    <section id="windows-startup" class="card" style="margin-bottom:16px">
      <div class="row between"><div><div class="eyebrow">Windows</div><h2 style="margin-top:5px">Inicio automático</h2></div><span class="badge"><span class="dot"></span> comprobando</span></div>
      <div class="empty" style="margin-top:14px">Consultando si SOL inicia con Windows…</div>
    </section>

    <section id="core-update" class="card" style="margin-bottom:16px">
      <div class="row between"><div><div class="eyebrow">SOL Core</div><h2 style="margin-top:5px">Actualizaciones</h2></div><span class="badge"><span class="dot"></span> comprobando</span></div>
      <div class="empty" style="margin-top:14px">Consultando la versión publicada…</div>
    </section>


    <section id="sol-appearance" class="card" style="margin-bottom:16px">
      <div class="row between">
        <div><div class="eyebrow">Personalización</div><h2 style="margin-top:5px">Colores de SOL</h2>
        <p class="muted small" style="margin-top:8px">Elegí los colores del tema. Se guardan automáticamente y se aplican a todas las páginas SOL de este navegador.</p></div>
        <button type="button" id="theme-reset">Restaurar</button>
      </div>
      <div class="row" style="margin:16px 0" id="theme-presets">
        <button type="button" data-theme="ocean">Océano</button>
        <button type="button" data-theme="amber">Ámbar</button>
        <button type="button" data-theme="forest">Bosque</button>
        <button type="button" data-theme="violet">Violeta</button>
      </div>
      <div class="theme-color-grid">
        <label>Color principal <input type="color" data-theme-color="accent" value="#aee7ff"/></label>
        <label>Fondo <input type="color" data-theme-color="background" value="#070d1a"/></label>
        <label>Paneles <input type="color" data-theme-color="panel" value="#13243c"/></label>
        <label>Texto <input type="color" data-theme-color="text" value="#f0f7ff"/></label>
        <label>Luz ambiental <input type="color" data-theme-color="glow" value="#5279bc"/></label>
      </div>
      <div class="small muted" role="status" id="theme-save-status" style="margin-top:14px">Preferencias de este navegador.</div>
      <p class="small muted" style="margin-top:8px">Para los colores, densidad, zoom y rotación de la constelación abrí <a href="/panorama/neural">el estudio neuronal</a>. Esos ajustes también se guardan y se reflejan en el panel de Panorama.</p>
    </section>
    <style>
      .theme-color-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}
      .theme-color-grid label{min-width:0}.theme-color-grid input[type=color]{height:44px;cursor:pointer;padding:4px}
      @media(max-width:750px){.theme-color-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    </style>

    <div class="grid">
      <a class="card action span4" href="/v1/inputs/plugins/extensions/ui" style="color:inherit;text-decoration:none"><div class="eyebrow">Extensiones</div><h2 style="margin-top:7px">Plugins</h2><p class="muted small">Instalar, actualizar, configurar y revisar plugins.</p></a>
      <a class="card action span4" href="/mcp" style="color:inherit;text-decoration:none"><div class="eyebrow">Herramientas</div><h2 style="margin-top:7px">MCP</h2><p class="muted small">Acceso unificado a herramientas nativas y de plugins.</p></a>
      <a class="card action span4" href="/ai" style="color:inherit;text-decoration:none"><div class="eyebrow">Razonamiento</div><h2 style="margin-top:7px">AI / Codex</h2><p class="muted small">Proveedores y runtime de razonamiento opcional.</p></a>
    </div>
  </section>`;

  const script = `
const API='/v1/inputs/plugins/core-update',STARTUP='/v1/inputs/plugins/windows-autostart',root=document.getElementById('core-update'),startup=document.getElementById('windows-startup'),check=document.getElementById('check-update');
const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]));
async function api(path,o={}){try{const r=await fetch(path,{cache:'no-store',...o});let b={};try{b=await r.json()}catch{}return{r,b}}catch(e){return{r:{ok:false,status:0},b:{error:e?.message||'Error de conexión'}}}}
function shortCommit(value){return value&&value!=='development'?String(value).slice(0,8):'desarrollo'}
function renderStartup(s){
  if(!s.supported){startup.innerHTML='<div class="row between"><div><div class="eyebrow">Windows</div><h2 style="margin-top:5px">Inicio automático</h2></div><span class="badge">no disponible</span></div>';return}
  const enabled=!!s.enabled,manage=!!s.canManage;
  startup.innerHTML='<div class="row between"><div><div class="eyebrow">Windows</div><h2 style="margin-top:5px">Inicio automático</h2><p class="muted small" style="margin:8px 0 0">SOL puede iniciar al entrar a Windows sin abrir el navegador. Core, plugins, Nexo y el bridge de Render quedan listos en segundo plano.</p></div><span class="badge"><span class="dot '+(enabled?'good':'warn')+'"></span>'+(enabled?'activado':'desactivado')+'</span></div><div class="divider"></div><div class="row between"><div class="small muted">'+(enabled?'SOL.exe se iniciará con <code>--background</code>.':'SOL sólo inicia cuando lo abrís manualmente.')+'</div>'+(manage?'<button id="toggle-startup">'+(enabled?'Desactivar':'Activar')+'</button>':'<span class="small muted">Sólo el owner puede cambiarlo.</span>')+'</div>';
  const btn=document.getElementById('toggle-startup');if(btn)btn.onclick=()=>setStartup(!enabled,btn)
}
async function loadStartup(){const out=await api(STARTUP);if(!out.r.ok){startup.innerHTML='<div class="empty error">'+esc(out.b.error||'No se pudo consultar el inicio automático')+'</div>';return}renderStartup(out.b)}
async function setStartup(enabled,btn){btn.disabled=true;const out=await api(STARTUP,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled})});btn.disabled=false;if(!out.r.ok){alert(out.b.error||'No se pudo cambiar el inicio automático');return}renderStartup(out.b)}
function renderStatus(s){const installed=s.installed||{},latest=s.latest||{},manageable=!!s.canManageCoreUpdate;let state='',action='';if(s.updateAvailable){state='<span class="badge"><span class="dot warn"></span> actualización disponible</span>';if(manageable&&s.canInstall)action='<button class="primary" id="install-core-update">Actualizar ahora</button>';else if(!manageable)action='<span class="muted small">Sólo el owner puede actualizar SOL Core.</span>';else action='<span class="muted small">La instalación automática requiere el paquete portable de Windows con updater.</span>'}else{state='<span class="badge"><span class="dot good"></span> actualizado</span>';action='<span class="goodtext small">No hay una versión más nueva publicada.</span>'}root.innerHTML='<div class="row between"><div><div class="eyebrow">SOL Core</div><h2 style="margin-top:5px">Actualizaciones</h2></div>'+state+'</div><div class="grid" style="margin-top:16px"><div class="span4"><div class="label">Instalada</div><div class="stat" style="font-size:22px">v'+esc(installed.version||'—')+'</div><div class="muted micro">'+esc(shortCommit(installed.commit))+'</div></div><div class="span4"><div class="label">Publicada</div><div class="stat" style="font-size:22px">v'+esc(latest.version||'—')+'</div><div class="muted micro">'+esc(shortCommit(latest.commit))+'</div></div><div class="span4"><div class="label">Canal</div><div style="margin-top:8px"><strong>'+esc(latest.channel||'stable')+'</strong></div><div class="muted micro">'+esc(latest.publishedAt?new Date(latest.publishedAt).toLocaleString():'')+'</div></div></div><div class="divider"></div><div class="row between"><div class="muted small">El updater verifica SHA-256, conserva %LOCALAPPDATA%\\SOL y restaura la versión anterior si el nuevo build no responde en /health.</div><div class="cluster">'+action+'</div></div>';const install=document.getElementById('install-core-update');if(install)install.onclick=()=>installUpdate(install)}
async function load(force=false){check.disabled=true;check.textContent=force?'Buscando…':'Buscar actualizaciones';const out=await api(API+(force?'?force=1':''));check.disabled=false;check.textContent='Buscar actualizaciones';if(!out.r.ok){root.innerHTML='<div class="row between"><div><div class="eyebrow">SOL Core</div><h2 style="margin-top:5px">Actualizaciones</h2></div><span class="badge"><span class="dot bad"></span> sin conexión</span></div><div class="callout error" style="margin-top:14px">'+esc(out.b.error||'No se pudo comprobar la versión publicada.')+'</div>';return}renderStatus(out.b)}
async function installUpdate(btn){if(!confirm('SOL descargará la nueva versión, verificará su SHA-256, se reiniciará y hará rollback automáticamente si el nuevo build no levanta.\\n\\n¿Actualizar ahora?'))return;btn.disabled=true;btn.textContent='Preparando…';const out=await api(API+'/install',{method:'POST'});if(!out.r.ok){btn.disabled=false;btn.textContent='Actualizar ahora';alert(out.b.error||'No se pudo iniciar la actualización');return}root.innerHTML='<div class="row between"><div><div class="eyebrow">SOL Core</div><h2 style="margin-top:5px">Actualizando a v'+esc(out.b.version||'')+'</h2></div><span class="badge"><span class="dot warn"></span> reiniciando</span></div><div class="callout" style="margin-top:14px">SOL se cerrará, el updater reemplazará el paquete y volverá a iniciar. Esta página se reconectará automáticamente.</div>';waitForRestart()}
async function waitForRestart(){let sawDown=false;for(let i=0;i<90;i++){await new Promise(r=>setTimeout(r,1000));try{const r=await fetch('/health',{cache:'no-store'});if(r.ok&&sawDown){location.reload();return}if(!r.ok)sawDown=true}catch{sawDown=true}}root.innerHTML+='<div class="callout warntext" style="margin-top:12px">La UI todavía no volvió a conectar. Revisá el log del updater en %LOCALAPPDATA%\\SOL\\logs.</div>'}

const themeInputs=Array.from(document.querySelectorAll("[data-theme-color]"));
const themeStatus=document.getElementById("theme-save-status");
function showTheme(){
  if(!window.SOLTheme)return;
  const state=window.SOLTheme.get();
  themeInputs.forEach(input=>{const key=input.dataset.themeColor;if(state[key])input.value=state[key]});
}
themeInputs.forEach(input=>input.addEventListener("input",()=>{
  const key=input.dataset.themeColor;
  window.SOLTheme.set({[key]:input.value});
  themeStatus.textContent="Colores guardados y aplicados";
}));
document.querySelectorAll("[data-theme]").forEach(btn=>btn.addEventListener("click",()=>{
  window.SOLTheme.preset(btn.dataset.theme);showTheme();
  themeStatus.textContent="Tema guardado";
}));
document.getElementById("theme-reset").addEventListener("click",()=>{
  window.SOLTheme.reset();showTheme();themeStatus.textContent="Colores restaurados";
});
window.addEventListener("sol-theme-change",showTheme);
showTheme();

check.onclick=()=>load(true);loadStartup();load();
`;

  return solPage("system", "Sistema", body, script);
}
