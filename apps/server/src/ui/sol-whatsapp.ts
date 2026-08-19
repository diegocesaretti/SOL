export function renderSolWhatsappPage(): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SOL · Mi WhatsApp</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; background:Canvas; color:CanvasText; }
    main { width:min(880px, calc(100% - 32px)); margin:auto; padding:44px 0 80px; }
    .top,.row,.actions { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
    .top,.row { justify-content:space-between; }
    .brand { font-size:13px; font-weight:900; letter-spacing:.17em; opacity:.65; }
    nav { display:flex; gap:14px; font-size:14px; }
    a { color:inherit; }
    h1 { font-size:clamp(36px,6vw,60px); margin:14px 0 8px; letter-spacing:-.045em; }
    h2 { margin:0 0 8px; font-size:21px; }
    p { line-height:1.55; opacity:.8; }
    .card { margin-top:22px; padding:22px; border:1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius:20px; }
    .pill { padding:6px 10px; border-radius:999px; border:1px solid color-mix(in srgb, CanvasText 18%, transparent); font-size:12px; }
    button { padding:10px 14px; border:0; border-radius:999px; font:inherit; font-weight:800; cursor:pointer; background:CanvasText; color:Canvas; }
    button.secondary { background:transparent; color:CanvasText; border:1px solid color-mix(in srgb, CanvasText 22%, transparent); }
    button.danger { background:transparent; color:#d33; border:1px solid color-mix(in srgb, #d33 45%, transparent); }
    button:disabled { opacity:.45; cursor:wait; }
    input { width:100%; padding:11px 13px; border-radius:11px; border:1px solid color-mix(in srgb, CanvasText 22%, transparent); background:Canvas; color:CanvasText; font:inherit; }
    .qr { display:grid; justify-items:center; gap:10px; background:#fff; color:#111; border-radius:16px; padding:18px; margin:16px 0; }
    .qr img { width:min(320px,100%); }
    .code { font:900 25px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing:.09em; padding:14px; border-radius:12px; border:1px dashed color-mix(in srgb, CanvasText 30%, transparent); text-align:center; user-select:all; }
    .muted { opacity:.62; }
    .error { color:#d33; }
    .member { padding:9px 0; border-top:1px solid color-mix(in srgb, CanvasText 10%, transparent); }
    .member:first-child { border-top:0; }
  </style>
</head>
<body>
<main>
  <div class="top"><div class="brand">SOL · WHATSAPP</div><nav><a href="/">Inicio</a><a href="/whatsapp">Fuentes WhatsApp</a><a href="/executive">Día a día</a></nav></div>
  <h1>Hablá con SOL.</h1>
  <p>Esta cuenta es la identidad propia de SOL: recibe preguntas y comandos de miembros vinculados, entrega briefs y pide aprobaciones. No se trata como una cuenta personal monitoreada.</p>
  <section id="app" class="card"><p class="muted">Cargando…</p></section>
</main>
<script>
  const app = document.getElementById('app');
  let poll;
  function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]));}
  async function api(path, options={}){const response=await fetch(path,{cache:'no-store',...options});let body={};try{body=await response.json();}catch{}return{response,body};}
  function stateLabel(s){return({idle:'Desconectado',connecting:'Conectando',qr:'Esperando vínculo',open:'Conectado',reconnecting:'Reconectando',error:'Error',logged_out:'Desvinculado'})[s]||s;}

  async function load(){
    clearTimeout(poll);
    const [me,res]=await Promise.all([api('/v1/auth/me'),api('/v1/sol-whatsapp')]);
    if(!me.response.ok){app.innerHTML='<h2>Necesitás iniciar sesión</h2><p><a href="/">Volver</a></p>';return;}
    if(!res.response.ok){app.innerHTML='<p class="error">'+esc(res.body.error||'No se pudo cargar')+'</p>';return;}
    const member=me.body.member, account=res.body.account, binding=res.body.binding;
    if(!account){
      const canManage=member.role==='owner'||member.role==='adult';
      app.innerHTML='<h2>WhatsApp de SOL todavía no está creado</h2><p>Se necesita una cuenta/número dedicado para SOL. Una vez creado, se vincula como dispositivo de WhatsApp mediante QR.</p>'+(canManage?'<button id="create">Crear canal de SOL</button>':'<p class="muted">Un owner/adult del hogar debe crearlo.</p>');
      if(canManage) document.getElementById('create').onclick=async()=>{await api('/v1/sol-whatsapp/account',{method:'POST'});await load();};
      return;
    }
    const rt=account.runtime||{};
    const canManage=account.canManage;
    const qr=canManage&&rt.qrDataUrl?'<div class="qr"><img src="'+esc(rt.qrDataUrl)+'"><strong>WhatsApp → Dispositivos vinculados → Vincular dispositivo</strong></div>':'';
    const linked=binding&&binding.verifiedAt&&!binding.disabled;
    const managerButtons=canManage?'<div class="actions"><button id="connect">'+(rt.state==='open'?'Reiniciar conexión':'Conectar / mostrar QR')+'</button><button class="secondary" id="pair">Usar código</button>'+(account.linkedAt?'<button class="danger" id="logout">Desvincular cuenta SOL</button>':'')+'</div><div id="pairbox"></div>':'';
    const bindings=(res.body.bindings||[]).map(b=>'<div class="member"><strong>'+esc(b.displayName)+'</strong> · '+esc(b.role)+' · '+(b.verifiedAt&&!b.disabled?'✓ vinculado':'sin vincular')+'</div>').join('');
    app.innerHTML='<div class="row"><div><h2>'+esc(account.label)+'</h2><div class="muted">'+esc(account.phoneJid||'sin número vinculado')+'</div></div><span class="pill">'+esc(stateLabel(rt.state))+'</span></div>'+ (rt.lastError?'<p class="error">'+esc(rt.lastError)+'</p>':'') + qr + managerButtons + '<div class="card"><h2>Tu identidad</h2>'+(linked?'<p>✓ Este WhatsApp ya está vinculado a <strong>'+esc(member.displayName)+'</strong>.</p><div class="actions"><button class="danger" id="revoke">Revocar mi vínculo</button></div>':'<p>Generá un código y mandalo desde <strong>tu propio WhatsApp</strong> al número de SOL. El código dura 10 minutos y hace el vínculo de identidad sin confiar en nombres o números inferidos.</p><button id="bind">Vincular mi WhatsApp</button><div id="bindbox"></div>')+'</div>'+(canManage?'<div class="card"><h2>Miembros vinculados</h2>'+(bindings||'<p class="muted">Todavía ninguno.</p>')+'</div>':'');

    if(canManage){
      document.getElementById('connect').onclick=async()=>{const endpoint=rt.state==='open'?'restart':'connect';await api('/v1/sol-whatsapp/'+endpoint,{method:'POST'});await load();};
      const logout=document.getElementById('logout'); if(logout) logout.onclick=async()=>{if(confirm('¿Desvincular la cuenta propia de SOL?')){await api('/v1/sol-whatsapp/logout',{method:'POST'});await load();}};
      document.getElementById('pair').onclick=()=>{document.getElementById('pairbox').innerHTML='<p>Número completo con código de país:</p><input id="phone" placeholder="549..." inputmode="numeric"><div class="actions"><button id="pairgo">Generar código</button></div><div id="pairstatus"></div>';document.getElementById('pairgo').onclick=async()=>{const out=await api('/v1/sol-whatsapp/pairing-code',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phoneNumber:document.getElementById('phone').value})});document.getElementById('pairstatus').innerHTML=out.response.ok?'<div class="code">'+esc(out.body.runtime?.pairingCode||'')+'</div>':'<p class="error">'+esc(out.body.error||'Error')+'</p>';};};
    }
    const bind=document.getElementById('bind'); if(bind) bind.onclick=async()=>{bind.disabled=true;const out=await api('/v1/sol-whatsapp/bind/start',{method:'POST'});const box=document.getElementById('bindbox');if(!out.response.ok)box.innerHTML='<p class="error">'+esc(out.body.error||'Error')+'</p>';else box.innerHTML='<p>Mandá este mensaje al WhatsApp de SOL:</p><div class="code">'+esc(out.body.code)+'</div><p class="muted">Vence: '+esc(new Date(out.body.expiresAt).toLocaleTimeString())+'</p>';bind.disabled=false;};
    const revoke=document.getElementById('revoke'); if(revoke) revoke.onclick=async()=>{await api('/v1/sol-whatsapp/bind/revoke',{method:'POST'});await load();};
    poll=setTimeout(load, rt.state==='connecting'||rt.state==='qr'||rt.state==='reconnecting'?1800:8000);
  }
  load();
</script>
</body>
</html>`;
}
