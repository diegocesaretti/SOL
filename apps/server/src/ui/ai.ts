export function renderAiPage(): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SOL · AI Engine</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: Canvas; color: CanvasText; }
    main { width: min(820px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0 72px; }
    a { color: inherit; }
    .brand { font-size: 13px; font-weight: 850; letter-spacing: .18em; opacity: .65; }
    h1 { margin: 12px 0 8px; font-size: clamp(34px, 7vw, 58px); letter-spacing: -.04em; }
    h2 { margin: 0 0 8px; font-size: 22px; }
    p { line-height: 1.55; opacity: .78; }
    .card { margin-top: 24px; padding: 24px; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 22px; background: color-mix(in srgb, Canvas 96%, CanvasText 4%); }
    .row { display: flex; justify-content: space-between; align-items: center; gap: 18px; padding: 13px 0; border-top: 1px solid color-mix(in srgb, CanvasText 11%, transparent); }
    .row:first-of-type { border-top: 0; }
    .muted { opacity: .62; }
    .pill { display: inline-flex; align-items: center; gap: 7px; padding: 7px 11px; border-radius: 999px; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); font-size: 13px; white-space: nowrap; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #2ca44f; }
    .dot.off { background: #999; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
    button, .button { padding: 11px 16px; border-radius: 999px; border: 0; background: CanvasText; color: Canvas; font: inherit; font-weight: 800; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; }
    button.secondary, .button.secondary { background: transparent; color: CanvasText; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); }
    button:disabled { opacity: .45; cursor: wait; }
    textarea { width: 100%; min-height: 110px; resize: vertical; padding: 13px 14px; border-radius: 14px; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); background: Canvas; color: CanvasText; font: inherit; }
    pre { white-space: pre-wrap; word-break: break-word; padding: 16px; border-radius: 14px; background: color-mix(in srgb, CanvasText 7%, transparent); min-height: 70px; }
    .error { color: #d33; }
    .code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 1.15em; font-weight: 800; letter-spacing: .04em; }
    .meter { height: 8px; border-radius: 999px; overflow: hidden; background: color-mix(in srgb, CanvasText 12%, transparent); margin-top: 8px; }
    .meter > span { display:block; height:100%; background: CanvasText; width:0; }
  </style>
</head>
<body>
  <main>
    <div class="brand">SOL · AI ENGINE</div>
    <h1>Codex</h1>
    <p>Conecta SOL con tu cuenta de ChatGPT mediante la autenticación administrada por Codex. SOL no guarda tokens OAuth en su base de datos.</p>
    <p><a href="/">← Volver al hogar</a></p>

    <section class="card">
      <h2>Estado</h2>
      <div id="status"><p class="muted">Consultando Codex…</p></div>
      <div class="actions" id="actions"></div>
      <div id="login-help"></div>
    </section>

    <section class="card" id="test-card" hidden>
      <h2>Probar SOL</h2>
      <p>Esta prueba manda únicamente tu identidad SOL y el nombre/zona horaria del hogar. Todavía no consulta WhatsApp ni otras fuentes.</p>
      <textarea id="prompt">Presentate brevemente y decime a qué hogar estás asistiendo.</textarea>
      <div class="actions"><button id="run-test">Probar razonamiento</button></div>
      <pre id="result" class="muted">Sin ejecutar.</pre>
    </section>
  </main>
<script>
  const statusEl = document.getElementById('status');
  const actionsEl = document.getElementById('actions');
  const helpEl = document.getElementById('login-help');
  const testCard = document.getElementById('test-card');
  const resultEl = document.getElementById('result');

  function esc(v) { return String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c])); }

  async function api(path, options = {}) {
    const response = await fetch(path, { cache: 'no-store', ...options });
    let body = {};
    try { body = await response.json(); } catch {}
    if (response.status === 401) { location.href = '/'; throw new Error('unauthenticated'); }
    return { response, body };
  }

  function rateHtml(rate) {
    const primary = rate?.primary;
    if (!primary || typeof primary.usedPercent !== 'number') return '<span class="muted">Sin datos de cuota</span>';
    const percent = Math.max(0, Math.min(100, primary.usedPercent));
    const reset = primary.resetsAt ? new Date(primary.resetsAt * 1000).toLocaleString() : '—';
    return '<div><strong>' + esc(percent) + '% usado</strong><div class="meter"><span style="width:' + percent + '%"></span></div><span class="muted">Reinicio: ' + esc(reset) + '</span></div>';
  }

  async function refresh() {
    const { response, body } = await api('/v1/ai/status');
    if (!response.ok) throw new Error(body.error || 'No se pudo consultar Codex');

    if (!body.available) {
      statusEl.innerHTML = '<div class="row"><div><strong>Codex App Server</strong><br><span class="error">' + esc(body.error || 'No disponible') + '</span></div><span class="pill"><span class="dot off"></span>No disponible</span></div>';
      actionsEl.innerHTML = '';
      helpEl.innerHTML = '<p class="muted">Verificá que el ejecutable <span class="code">codex</span> esté instalado y disponible para el proceso de SOL.</p>';
      testCard.hidden = true;
      return;
    }

    if (body.connected) {
      const account = body.account || {};
      statusEl.innerHTML =
        '<div class="row"><div><strong>ChatGPT conectado</strong><br><span class="muted">' + esc(account.email || 'Cuenta ChatGPT') + ' · ' + esc(account.planType || 'plan no informado') + '</span></div><span class="pill"><span class="dot"></span>Activo</span></div>' +
        '<div class="row"><div><strong>Uso Codex</strong></div><div style="min-width:220px">' + rateHtml(body.rateLimits) + '</div></div>';
      actionsEl.innerHTML = '<button class="secondary" id="logout">Desconectar Codex</button>';
      helpEl.innerHTML = '';
      testCard.hidden = false;
      document.getElementById('logout').onclick = async () => {
        await api('/v1/ai/codex/logout', { method:'POST', headers:{'content-type':'application/json'}, body:'{}' });
        await refresh();
      };
      return;
    }

    statusEl.innerHTML = '<div class="row"><div><strong>ChatGPT</strong><br><span class="muted">Codex está ejecutándose pero no tiene una sesión ChatGPT activa.</span></div><span class="pill"><span class="dot off"></span>Desconectado</span></div>';
    actionsEl.innerHTML = '<button id="browser-login">Conectar con ChatGPT</button><button class="secondary" id="device-login">Usar código de dispositivo</button>';
    helpEl.innerHTML = '';
    testCard.hidden = true;

    document.getElementById('browser-login').onclick = () => beginLogin('browser');
    document.getElementById('device-login').onclick = () => beginLogin('device');
  }

  async function beginLogin(flow) {
    actionsEl.querySelectorAll('button').forEach(b => b.disabled = true);
    const { response, body } = await api('/v1/ai/codex/login', {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ flow })
    });
    if (!response.ok) {
      helpEl.innerHTML = '<p class="error">' + esc(body.error || 'No se pudo iniciar el login') + '</p>';
      await refresh();
      return;
    }
    const login = body.login || {};
    if (login.type === 'chatgpt' && login.authUrl) {
      helpEl.innerHTML = '<p>Se abrió el login de ChatGPT. Cuando termine, volvé a esta pestaña.</p><p><a class="button secondary" target="_blank" rel="noopener" href="' + esc(login.authUrl) + '">Abrir login otra vez</a></p>';
      window.open(login.authUrl, '_blank', 'noopener');
    } else if (login.type === 'chatgptDeviceCode') {
      helpEl.innerHTML = '<p>Abrí el enlace e ingresá este código:</p><p class="code">' + esc(login.userCode) + '</p><p><a class="button secondary" target="_blank" rel="noopener" href="' + esc(login.verificationUrl) + '">Abrir ChatGPT</a></p>';
    }
    pollUntilConnected();
  }

  async function pollUntilConnected() {
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const { body } = await api('/v1/ai/status');
      if (body.connected) { await refresh(); return; }
    }
  }

  document.getElementById('run-test').onclick = async () => {
    const button = document.getElementById('run-test');
    button.disabled = true;
    resultEl.className = 'muted';
    resultEl.textContent = 'Pensando…';
    const { response, body } = await api('/v1/ai/test', {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ message: document.getElementById('prompt').value })
    });
    if (!response.ok) {
      resultEl.className = 'error';
      resultEl.textContent = body.error || 'Falló la prueba';
    } else {
      resultEl.className = '';
      resultEl.textContent = body.result?.text || '(sin respuesta)';
    }
    button.disabled = false;
  };

  refresh().catch(error => {
    statusEl.innerHTML = '<p class="error">' + esc(error.message) + '</p>';
  });
  setInterval(() => { if (!document.hidden) refresh().catch(() => undefined); }, 15000);
</script>
</body>
</html>`;
}
