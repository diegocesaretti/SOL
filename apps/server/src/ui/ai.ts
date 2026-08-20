import { solPage } from "./shell.js";

export function renderAiPage(): string {
  const body = `<section class="page">
    <div class="eyebrow">SOL · AI</div>
    <h1>Enriquecimiento opcional.</h1>
    <p class="lead">Codex puede ayudar a extraer y consolidar información, pero no es la base de datos ni la autoridad de SOL. Inputs, Life y MCP siguen funcionando aunque AI esté desconectada.</p>
    <div class="grid">
      <section class="card span12">
        <div class="row between"><h2>Codex / ChatGPT</h2><span class="badge">enrichment</span></div>
        <div class="divider"></div>
        <div id="status"><div class="muted">Consultando Codex…</div></div>
        <div class="cluster" id="actions" style="margin-top:16px"></div>
        <div id="login-help"></div>
      </section>
      <section class="card span12" id="test-card" hidden>
        <h2>Probar razonamiento</h2>
        <p class="small muted" style="line-height:1.55">Esta prueba usa el contexto mínimo autorizado por el endpoint de prueba. La ingesta de Inputs no depende de esta conexión.</p>
        <textarea id="prompt" style="min-height:110px;resize:vertical">Presentate brevemente y decime a qué hogar estás asistiendo.</textarea>
        <div class="cluster" style="margin-top:12px"><button class="primary" id="run-test">Probar razonamiento</button></div>
        <pre id="result" class="muted" style="white-space:pre-wrap;word-break:break-word;background:#0d1015;padding:14px;border-radius:12px;min-height:70px">Sin ejecutar.</pre>
      </section>
    </div>
  </section>`;

  const script = `
const statusEl=document.getElementById('status'),actionsEl=document.getElementById('actions'),helpEl=document.getElementById('login-help'),testCard=document.getElementById('test-card'),resultEl=document.getElementById('result');
function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]))}
async function api(path,o={}){const c=new AbortController(),t=setTimeout(()=>c.abort(),12000);try{const r=await fetch(path,{cache:'no-store',...o,signal:c.signal});let b={};try{b=await r.json()}catch{}if(r.status===401){location.href='/';throw new Error('unauthenticated')}return{r,b}}catch(e){if(e?.message==='unauthenticated')throw e;return{r:{ok:false,status:0},b:{error:e?.name==='AbortError'?'Tiempo de espera agotado':e?.message||'Error de conexión'}}}finally{clearTimeout(t)}}
function rateHtml(rate){const p=rate?.primary;if(!p||typeof p.usedPercent!=='number')return '<span class="small muted">Sin datos de cuota</span>';const percent=Math.max(0,Math.min(100,p.usedPercent)),reset=p.resetsAt?new Date(p.resetsAt*1000).toLocaleString():'—';return '<div><strong>'+esc(percent)+'% usado</strong><div style="height:7px;border-radius:99px;background:#0d1015;overflow:hidden;margin:7px 0"><span style="display:block;height:100%;background:var(--text);width:'+percent+'%"></span></div><span class="small muted">Reinicio: '+esc(reset)+'</span></div>'}
async function refresh(){const {r,b}=await api('/v1/ai/status');if(!r.ok)throw new Error(b.error||'No se pudo consultar Codex');if(!b.available){statusEl.innerHTML='<div class="row between"><div><strong>Codex App Server</strong><div class="small error" style="margin-top:4px">'+esc(b.error||'No disponible')+'</div></div><span class="badge"><span class="dot bad"></span>No disponible</span></div>';actionsEl.innerHTML='';helpEl.innerHTML='<p class="small muted">Verificá que el ejecutable <code>codex</code> esté instalado y disponible para el proceso de SOL.</p>';testCard.hidden=true;return}if(b.connected){const a=b.account||{};statusEl.innerHTML='<div class="row between"><div><strong>ChatGPT conectado</strong><div class="small muted" style="margin-top:4px">'+esc(a.email||'Cuenta ChatGPT')+' · '+esc(a.planType||'plan no informado')+'</div></div><span class="badge"><span class="dot good"></span>Activo</span></div><div class="divider"></div><div class="row between"><strong>Uso Codex</strong><div style="min-width:220px">'+rateHtml(b.rateLimits)+'</div></div>';actionsEl.innerHTML='<button id="logout">Desconectar Codex</button>';helpEl.innerHTML='';testCard.hidden=false;document.getElementById('logout').onclick=async()=>{await api('/v1/ai/codex/logout',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});await refresh()};return}statusEl.innerHTML='<div class="row between"><div><strong>ChatGPT</strong><div class="small muted" style="margin-top:4px">Codex está ejecutándose pero no tiene una sesión ChatGPT activa.</div></div><span class="badge"><span class="dot warn"></span>Desconectado</span></div>';actionsEl.innerHTML='<button class="primary" id="browser-login">Conectar con ChatGPT</button><button id="device-login">Usar código de dispositivo</button>';helpEl.innerHTML='';testCard.hidden=true;document.getElementById('browser-login').onclick=()=>beginLogin('browser');document.getElementById('device-login').onclick=()=>beginLogin('device')}
async function beginLogin(flow){actionsEl.querySelectorAll('button').forEach(b=>b.disabled=true);const {r,b}=await api('/v1/ai/codex/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({flow})});if(!r.ok){helpEl.innerHTML='<p class="error">'+esc(b.error||'No se pudo iniciar el login')+'</p>';await refresh();return}const login=b.login||{};if(login.type==='chatgpt'&&login.authUrl){helpEl.innerHTML='<p class="small muted">Se abrió el login de ChatGPT. Cuando termine, volvé a esta pestaña.</p><a class="button" target="_blank" rel="noopener" href="'+esc(login.authUrl)+'">Abrir login otra vez</a>';window.open(login.authUrl,'_blank','noopener')}else if(login.type==='chatgptDeviceCode'){helpEl.innerHTML='<p class="small muted">Abrí el enlace e ingresá este código:</p><div style="font-family:ui-monospace,Consolas,monospace;font-size:22px;font-weight:900;margin:10px 0">'+esc(login.userCode)+'</div><a class="button" target="_blank" rel="noopener" href="'+esc(login.verificationUrl)+'">Abrir ChatGPT</a>'}pollUntilConnected()}
async function pollUntilConnected(){for(let i=0;i<120;i++){await new Promise(r=>setTimeout(r,2000));const {b}=await api('/v1/ai/status');if(b.connected){await refresh();return}}}
document.getElementById('run-test').onclick=async()=>{const button=document.getElementById('run-test');button.disabled=true;resultEl.className='muted';resultEl.textContent='Pensando…';const {r,b}=await api('/v1/ai/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:document.getElementById('prompt').value})});if(!r.ok){resultEl.className='error';resultEl.textContent=b.error||'Falló la prueba'}else{resultEl.className='';resultEl.textContent=b.result?.text||'(sin respuesta)'}button.disabled=false};
refresh().catch(error=>{statusEl.innerHTML='<div class="error">'+esc(error.message)+'</div>'});setInterval(()=>{if(!document.hidden)refresh().catch(()=>undefined)},15000);
`;
  return solPage("ai", "AI", body, script);
}
