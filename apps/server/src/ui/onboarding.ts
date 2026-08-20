export function renderOnboardingPage(): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SOL · Inicio</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: Canvas; color: CanvasText; }
    main { width: min(900px, calc(100% - 32px)); margin: 0 auto; padding: 52px 0 80px; }
    .brand { font-size: 14px; font-weight: 850; letter-spacing: .18em; opacity: .7; }
    h1 { margin: 12px 0 8px; font-size: clamp(36px, 7vw, 64px); letter-spacing: -.04em; }
    h2 { margin: 0 0 8px; font-size: 24px; }
    h3 { margin: 24px 0 6px; font-size: 17px; }
    p { line-height: 1.55; opacity: .8; }
    a { color: inherit; }
    .card { margin-top: 28px; padding: 26px; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 22px; background: color-mix(in srgb, Canvas 96%, CanvasText 4%); }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    label { display: grid; gap: 7px; font-size: 13px; font-weight: 700; }
    label.full { grid-column: 1 / -1; }
    input, select { width: 100%; padding: 12px 14px; border-radius: 12px; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); background: Canvas; color: CanvasText; font: inherit; }
    button, .action-link { margin-top: 18px; padding: 11px 16px; border: 0; border-radius: 999px; font: inherit; font-weight: 800; cursor: pointer; background: CanvasText; color: Canvas; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
    button.secondary, .action-link.secondary { background: transparent; color: CanvasText; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); }
    button:disabled { opacity: .45; cursor: wait; }
    .status { margin-top: 14px; min-height: 20px; font-size: 14px; }
    .error { color: #d33; }
    .muted { opacity: .62; }
    .pill { display: inline-flex; align-items: center; gap: 8px; padding: 7px 11px; border-radius: 999px; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); font-size: 13px; white-space: nowrap; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #2ca44f; }
    .row { display: flex; justify-content: space-between; gap: 20px; align-items: center; padding: 15px 0; border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent); }
    .row:first-of-type { border-top: 0; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .modules { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-top: 20px; }
    .module { display: block; padding: 18px; border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 17px; text-decoration: none; min-height: 105px; }
    .module strong { display: block; margin-bottom: 6px; font-size: 17px; }
    .module span { font-size: 13px; opacity: .66; line-height: 1.4; }
    .module.primary { background: color-mix(in srgb, CanvasText 7%, Canvas); }
    details { margin-top: 18px; padding-top: 16px; border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent); }
    summary { cursor: pointer; font-weight: 800; }
    details form { margin-top: 16px; }
    @media (max-width: 680px) { main { padding: 34px 0 60px; } .grid, .modules { grid-template-columns: 1fr; } label.full { grid-column: auto; } .card { padding: 21px; } .row { align-items: flex-start; } }
  </style>
</head>
<body>
  <main>
    <div class="brand">SOL</div>
    <h1>Tu hogar, conectado.</h1>
    <p id="intro">Iniciando SOL…</p>
    <section class="card" id="app"><p class="muted">Cargando estado del sistema…</p></section>
  </main>
<script>
  const app = document.getElementById('app');
  const intro = document.getElementById('intro');

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;'
    })[char]);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { cache: 'no-store', ...options });
    let body = {};
    try { body = await response.json(); } catch {}
    return { response, body };
  }

  function onboardingView() {
    intro.textContent = 'Primero definimos el hogar y a la primera persona administradora. Después sumamos miembros y fuentes.';
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const locale = navigator.language || 'es-AR';
    app.innerHTML = \`
      <h2>Crear hogar</h2>
      <p>El primer perfil será owner. Los demás miembros tendrán su propio acceso, privacidad y fuentes.</p>
      <form id="setup-form"><div class="grid">
        <label class="full">Nombre del hogar<input name="householdName" autocomplete="organization" required maxlength="120" /></label>
        <label>Tu nombre<input name="ownerName" autocomplete="name" required maxlength="120" /></label>
        <label>Usuario<input name="ownerLogin" autocomplete="username" required minlength="3" maxlength="40" pattern="[A-Za-z0-9._-]+" /></label>
        <label>Contraseña<input name="ownerPassword" type="password" autocomplete="new-password" required minlength="8" maxlength="256" /></label>
        <label>Zona horaria<input name="timezone" value="\${escapeHtml(timezone)}" required maxlength="100" /></label>
      </div><input type="hidden" name="ownerLocale" value="\${escapeHtml(locale)}" />
      <button>Crear SOL Home</button><div class="status" id="status"></div></form>
    \`;
    const form = document.getElementById('setup-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); const button=form.querySelector('button'); const status=document.getElementById('status');
      button.disabled=true; status.textContent='Creando hogar…'; status.className='status';
      const data=Object.fromEntries(new FormData(form).entries());
      const result=await api('/v1/onboarding',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
      if(!result.response.ok){status.className='status error';status.textContent=result.body.error||'No se pudo crear el hogar';button.disabled=false;return}
      await load();
    });
  }

  function loginView(state) {
    intro.textContent = 'Cada miembro entra con su identidad. SOL filtra privacidad antes de consultar fuentes o IA.';
    const options=state.households.map(h=>\`<option value="\${escapeHtml(h.id)}">\${escapeHtml(h.name)}</option>\`).join('');
    app.innerHTML=\`<h2>Entrar a SOL</h2><form id="login-form"><div class="grid">
      <label class="full">Hogar<select name="householdId">\${options}</select></label>
      <label>Usuario<input name="loginName" autocomplete="username" required maxlength="40" /></label>
      <label>Contraseña<input name="password" type="password" autocomplete="current-password" required maxlength="256" /></label>
    </div><button>Entrar</button><div class="status" id="status"></div></form>\`;
    const form=document.getElementById('login-form');
    form.addEventListener('submit',async(event)=>{event.preventDefault();const button=form.querySelector('button');const status=document.getElementById('status');button.disabled=true;status.textContent='Entrando…';const data=Object.fromEntries(new FormData(form).entries());const result=await api('/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});if(!result.response.ok){status.className='status error';status.textContent=result.response.status===401?'Usuario o contraseña incorrectos.':result.body.error||'No se pudo entrar';button.disabled=false;return}await load()});
  }

  async function homeView(state, member) {
    const household=state.households.find(item=>item.id===member.householdId);
    intro.textContent='Una sola SOL: información, agenda, decisiones y automatizaciones del hogar.';
    const [membersResult,sourcesResult,proposalResult]=await Promise.all([
      api('/v1/households/'+encodeURIComponent(member.householdId)+'/members'),
      api('/v1/source-accounts'),
      api('/v1/executive/proposals?status=pending')
    ]);
    const members=membersResult.response.ok?membersResult.body.members:[];
    const sources=sourcesResult.response.ok?sourcesResult.body.sourceAccounts:[];
    const pending=proposalResult.response.ok?(proposalResult.body.proposals||[]).length:0;
    const manager=member.role==='owner'||member.role==='adult';
    const memberRows=members.map(item=>\`<div class="row"><div><strong>\${escapeHtml(item.displayName)}</strong><br><span class="muted">\${escapeHtml(item.role)}\${item.loginName?' · @'+escapeHtml(item.loginName):''}</span></div><span class="pill"><span class="dot"></span>\${escapeHtml(item.status)}</span></div>\`).join('');
    const sourceRows=sources.length?sources.map(item=>\`<div class="row"><div><strong>\${escapeHtml(item.label)}</strong><br><span class="muted">\${escapeHtml(item.provider)}\${item.ownerMemberId?' · personal':' · hogar'}</span></div><span class="pill">\${escapeHtml(item.status)}</span></div>\`).join(''):'<p class="muted">Todavía no hay fuentes conectadas.</p>';
    const roleOptions=member.role==='owner'?'<option value="adult">Adulto</option><option value="member">Miembro</option><option value="child">Niño/a</option><option value="guest">Invitado</option>':'<option value="member">Miembro</option><option value="child">Niño/a</option><option value="guest">Invitado</option>';
    const memberForm=manager?\`<details><summary>Agregar miembro</summary><form id="member-form"><div class="grid"><label>Nombre<input name="displayName" required maxlength="120" /></label><label>Rol<select name="role">\${roleOptions}</select></label><label>Usuario<input name="loginName" required minlength="3" maxlength="40" pattern="[A-Za-z0-9._-]+" /></label><label>Contraseña inicial<input name="password" type="password" required minlength="8" maxlength="256" /></label></div><button>Agregar</button><div class="status" id="member-status"></div></form></details>\`:'';

    app.innerHTML=\`
      <div class="row"><div><h2>\${escapeHtml(household?.name||'SOL Home')}</h2><span class="muted">Sesión: \${escapeHtml(member.displayName)} · \${escapeHtml(member.role)}</span></div><span class="pill">\${pending} por confirmar</span></div>
      <div class="modules">
        <a class="module primary" href="/sol-whatsapp"><strong>Hablar con SOL</strong><span>WhatsApp propio de SOL: preguntas, briefs, recordatorios y aprobaciones desde el teléfono.</span></a>
        <a class="module primary" href="/executive"><strong>Día a día</strong><span>Brief de hoy, tareas, conflictos y propuestas que SOL necesita que confirmes.</span></a>
        <a class="module primary" href="/life"><strong>Vida & Knowledge</strong><span>Timeline, personas y proyectos que SOL puede mostrar según tus permisos.</span></a>
        <a class="module" href="/calendar"><strong>Calendar</strong><span>Cuentas personales y familiares, calendarios leídos y destino de escritura.</span></a>
        <a class="module" href="/whatsapp"><strong>Fuentes WhatsApp</strong><span>Cuentas observadas, mensajes almacenados y candidatos detectados.</span></a>
        <a class="module" href="/home-assistant"><strong>Home Assistant</strong><span>Estados y cambios elegidos de la casa, en modo lectura y con selección explícita.</span></a>
        <a class="module" href="/mercadolibre"><strong>Mercado Libre</strong><span>Ventas, publicaciones y preguntas del negocio como fuente operativa de SOL.</span></a>
        <a class="module" href="/ai"><strong>AI Engine</strong><span>Codex / ChatGPT OAuth, estado, cuota y prueba de razonamiento.</span></a>
      </div>
      <h3>Miembros</h3>\${memberRows}\${memberForm}
      <h3>Fuentes</h3>\${sourceRows}
      <div class="actions"><a class="action-link secondary" href="/life">Abrir Vida</a><a class="action-link secondary" href="/mercadolibre">Abrir negocio</a><a class="action-link secondary" href="/sol-whatsapp">Abrir WhatsApp de SOL</a><a class="action-link secondary" href="/executive">Abrir día a día</a><button class="secondary" id="logout">Cerrar sesión</button></div>
    \`;

    const mf=document.getElementById('member-form');
    if(mf)mf.addEventListener('submit',async(event)=>{event.preventDefault();const status=document.getElementById('member-status');const button=mf.querySelector('button');button.disabled=true;status.textContent='Creando miembro…';const data=Object.fromEntries(new FormData(mf).entries());data.locale=navigator.language||'es-AR';const result=await api('/v1/households/'+encodeURIComponent(member.householdId)+'/members',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});if(!result.response.ok){status.className='status error';status.textContent=result.body.error||'No se pudo crear';button.disabled=false;return}await load()});
    document.getElementById('logout').addEventListener('click',async()=>{await api('/v1/auth/logout',{method:'POST'});await load()});
  }

  async function load(){
    try{
      const stateResult=await api('/v1/onboarding');
      if(!stateResult.response.ok)throw new Error(stateResult.body.error||'No se pudo consultar SOL');
      const state=stateResult.body;
      if(!state.configured){onboardingView();return}
      const me=await api('/v1/auth/me');
      if(me.response.ok)await homeView(state,me.body.member);else loginView(state);
    }catch(error){intro.textContent='SOL no pudo consultar su base de datos.';app.innerHTML=\`<h2>Base no disponible</h2><p class="error">\${escapeHtml(error.message)}</p><p class="muted">Verificá PostgreSQL/Neon y ejecutá pnpm db:migrate.</p>\`}
  }
  load();
</script>
</body></html>`;
}
