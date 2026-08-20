import { solPage } from "./shell.js";

export function renderAiPage(): string {
  const body = `<section class="page">
    <div class="eyebrow">SOL · AI</div>
    <h1>Enriquecimiento opcional.</h1>
    <p class="lead">Elegí cómo SOL interpreta los candidatos y consolida Life → Knowledge. La IA nunca es la autoridad de datos ni un requisito para Inputs, Life o MCP.</p>
    <div id="mode" class="card" style="margin-bottom:14px"><div class="muted">Consultando proveedores…</div></div>
    <div class="grid">
      <section class="card span6">
        <div class="row between"><div><h2>OpenAI API</h2><div class="small muted" style="margin-top:4px">Responses API · clave local</div></div><span class="badge" id="openai-badge">—</span></div>
        <div class="divider"></div>
        <div id="openai-status" class="muted">Cargando…</div>
      </section>
      <section class="card span6">
        <div class="row between"><div><h2>Codex / ChatGPT</h2><div class="small muted" style="margin-top:4px">OAuth · fallback/alternativa</div></div><span class="badge" id="codex-badge">—</span></div>
        <div class="divider"></div>
        <div id="codex-status" class="muted">Cargando…</div>
        <div class="cluster" id="codex-actions" style="margin-top:16px"></div>
        <div id="login-help"></div>
      </section>
      <section class="card span12" id="test-card" hidden>
        <div class="row between"><div><h2>Probar proveedor activo</h2><div class="small muted" style="margin-top:4px">La respuesta indica qué provider/modelo se usó realmente.</div></div><span class="badge" id="test-provider">—</span></div>
        <div class="divider"></div>
        <textarea id="prompt" style="min-height:110px;resize:vertical">Presentate brevemente y decime a qué hogar estás asistiendo.</textarea>
        <div class="cluster" style="margin-top:12px"><button class="primary" id="run-test">Probar razonamiento</button></div>
        <pre id="result" class="muted" style="white-space:pre-wrap;word-break:break-word;background:#0d1015;padding:14px;border-radius:12px;min-height:70px">Sin ejecutar.</pre>
      </section>
    </div>
  </section>`;

  const script = `
const modeEl=document.getElementById('mode'),openaiEl=document.getElementById('openai-status'),openaiBadge=document.getElementById('openai-badge'),codexEl=document.getElementById('codex-status'),codexBadge=document.getElementById('codex-badge'),actionsEl=document.getElementById('codex-actions'),helpEl=document.getElementById('login-help'),testCard=document.getElementById('test-card'),testProvider=document.getElementById('test-provider'),resultEl=document.getElementById('result');
function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]))}
async function api(path,o={}){const c=new AbortController(),t=setTimeout(()=>c.abort(),15000);try{const r=await fetch(path,{cache:'no-store',...o,signal:c.signal});let b={};try{b=await r.json()}catch{}if(r.status===401){location.href='/';throw new Error('unauthenticated')}return{r,b}}catch(e){if(e?.message==='unauthenticated')throw e;return{r:{ok:false,status:0},b:{error:e?.name==='AbortError'?'Tiempo de espera agotado':e?.message||'Error de conexión'}}}finally{clearTimeout(t)}}
function stateBadge(el,ok,label){el.innerHTML='<span class="dot '+(ok?'good':'bad')+'"></span>'+esc(label)}
function rateHtml(rate){const p=rate?.primary;if(!p||typeof p.usedPercent!=='number')return '';const percent=Math.max(0,Math.min(100,p.usedPercent)),reset=p.resetsAt?new Date(p.resetsAt*1000).toLocaleString():'—';return '<div class="divider"></div><div><strong>'+esc(percent)+'% usado</strong><div style="height:7px;border-radius:99px;background:#0d1015;overflow:hidden;margin:7px 0"><span style="display:block;height:100%;background:var(--text);width:'+percent+'%"></span></div><span class="small muted">Reinicio: '+esc(reset)+'</span></div>'}
function renderMode(b){const active=b.activeProvider||'ninguno',mode=b.mode||'auto';modeEl.innerHTML='<div class="row between"><div><div class="eyebrow">Routing</div><h2 style="margin-top:5px">Modo '+esc(mode)+'</h2><div class="small muted" style="margin-top:6px">'+(mode==='auto'?'OpenAI primero si hay clave; Codex queda como fallback.':'Proveedor fijado por configuración.')+'</div></div><span class="badge"><span class="dot '+(b.available?'good':'bad')+'"></span>activo: '+esc(active)+'</span></div>'}
function renderOpenAi(o){const configured=Boolean(o?.configured),available=Boolean(o?.available);stateBadge(openaiBadge,available,available?'disponible':configured?'configurado':'sin clave');openaiEl.innerHTML=available?'<div><strong>Listo para enriquecer</strong><div class="small muted" style="margin-top:7px">Clasificación: <code>'+esc(o.fastModel)+'</code><br>Consolidación/planificación: <code>'+esc(o.model)+'</code></div><p class="small muted" style="line-height:1.55">La API key se lee del entorno local y no se almacena en Neon.</p></div>':'<div><strong>'+(configured?'Configurado, pero no figura activo':'No configurado')+'</strong><p class="small muted" style="line-height:1.55">Agregá <code>SOL_OPENAI_API_KEY</code> o <code>OPENAI_API_KEY</code> a tu archivo <code>.env</code> y reiniciá SOL. La clave nunca se ingresa desde esta página.</p></div>'}
function renderCodex(c){const available=Boolean(c?.available),connected=Boolean(c?.connected);stateBadge(codexBadge,available,available?'disponible':connected?'conectado':'no disponible');if(connected){const a=c.account||{};codexEl.innerHTML='<div><strong>ChatGPT conectado</strong><div class="small muted" style="margin-top:5px">'+esc(a.email||'Cuenta ChatGPT')+' · '+esc(a.planType||'plan no informado')+'</div>'+rateHtml(c.rateLimits)+'</div>';actionsEl.innerHTML='<button id="logout">Desconectar Codex</button>';helpEl.innerHTML='';document.getElementById('logout').onclick=async()=>{await api('/v1/ai/codex/logout',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});await refresh()};return}if(c?.error&&!c?.available){codexEl.innerHTML='<div><strong>Codex no disponible</strong><div class="small error" style="margin-top:5px">'+esc(c.error)+'</div></div>';actionsEl.innerHTML='';helpEl.innerHTML='<p class="small muted">OpenAI puede funcionar independientemente de Codex.</p>';return}codexEl.innerHTML='<div><strong>ChatGPT no conectado</strong><p class="small muted">Podés conectarlo como fallback o elegir <code>SOL_AI_PROVIDER=codex</code>.</p></div>';actionsEl.innerHTML='<button class="primary" id="browser-login">Conectar con ChatGPT</button><button id="device-login">Código de dispositivo</button>';helpEl.innerHTML='';document.getElementById('browser-login').onclick=()=>beginLogin('browser');document.getElementById('device-login').onclick=()=>beginLogin('device')}
async function refresh(){const {r,b}=await api('/v1/ai/status');if(!r.ok)throw new Error(b.error||'No se pudo consultar AI');renderMode(b);renderOpenAi(b.providers?.openai||{});renderCodex(b.providers?.codex||{});testCard.hidden=!b.available;testProvider.textContent=b.activeProvider||'sin provider'}
async function beginLogin(flow){actionsEl.querySelectorAll('button').forEach(x=>x.disabled=true);const {r,b}=await api('/v1/ai/codex/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({flow})});if(!r.ok){helpEl.innerHTML='<p class="error">'+esc(b.error||'No se pudo iniciar el login')+'</p>';await refresh();return}const login=b.login||{};if(login.type==='chatgpt'&&login.authUrl){helpEl.innerHTML='<p class="small muted">Completá el login y volvé a esta pestaña.</p><a class="button" target="_blank" rel="noopener" href="'+esc(login.authUrl)+'">Abrir login</a>';window.open(login.authUrl,'_blank','noopener')}else if(login.type==='chatgptDeviceCode'){helpEl.innerHTML='<p class="small muted">Ingresá este código:</p><div style="font-family:ui-monospace,Consolas,monospace;font-size:22px;font-weight:900;margin:10px 0">'+esc(login.userCode)+'</div><a class="button" target="_blank" rel="noopener" href="'+esc(login.verificationUrl)+'">Abrir ChatGPT</a>'}pollUntilConnected()}
async function pollUntilConnected(){for(let i=0;i<120;i++){await new Promise(r=>setTimeout(r,2000));const {b}=await api('/v1/ai/status');if(b.providers?.codex?.connected){await refresh();return}}}
document.getElementById('run-test').onclick=async()=>{const button=document.getElementById('run-test');button.disabled=true;resultEl.className='muted';resultEl.textContent='Pensando…';const {r,b}=await api('/v1/ai/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:document.getElementById('prompt').value})});if(!r.ok){resultEl.className='error';resultEl.textContent=b.error||'Falló la prueba'}else{const meta=[b.result?.provider,b.result?.model].filter(Boolean).join(' · ');resultEl.className='';resultEl.textContent=(meta?meta+'\\n\\n':'')+(b.result?.text||'(sin respuesta)')}button.disabled=false};
refresh().catch(error=>{modeEl.innerHTML='<div class="error">'+esc(error.message)+'</div>'});setInterval(()=>{if(!document.hidden)refresh().catch(()=>undefined)},15000);
`;
  return solPage("ai", "AI", body, script);
}
