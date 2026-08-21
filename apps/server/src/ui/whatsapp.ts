export function renderWhatsappPage(): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SOL · WhatsApp</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: Canvas; color: CanvasText; }
    main { width: min(980px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0 80px; }
    a { color: inherit; }
    .top { display: flex; justify-content: space-between; gap: 16px; align-items: center; flex-wrap: wrap; }
    .brand { font-size: 14px; font-weight: 850; letter-spacing: .18em; opacity: .7; }
    nav { display: flex; gap: 14px; font-size: 14px; }
    h1 { margin: 12px 0 8px; font-size: clamp(34px, 6vw, 58px); letter-spacing: -.04em; }
    h2 { margin: 0 0 6px; font-size: 21px; }
    h3 { margin: 22px 0 8px; font-size: 16px; }
    p { line-height: 1.55; opacity: .8; }
    .card { margin-top: 24px; padding: 24px; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 20px; }
    .accounts { display: grid; gap: 18px; }
    .row { display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; }
    .meta { font-size: 13px; opacity: .65; margin-top: 4px; overflow-wrap: anywhere; }
    .pill { display: inline-flex; padding: 6px 10px; border-radius: 999px; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); font-size: 12px; white-space: nowrap; }
    .actions { display: flex; gap: 9px; flex-wrap: wrap; margin-top: 15px; }
    button { padding: 10px 14px; border-radius: 999px; border: 0; font: inherit; font-weight: 750; cursor: pointer; background: CanvasText; color: Canvas; }
    button.secondary { background: transparent; color: CanvasText; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); }
    button.danger { background: transparent; color: #d33; border: 1px solid color-mix(in srgb, #d33 45%, transparent); }
    button:disabled { opacity: .45; cursor: wait; }
    input, select { width: 100%; padding: 11px 13px; border-radius: 11px; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); background: Canvas; color: CanvasText; font: inherit; }
    label { display: grid; gap: 6px; font-size: 13px; font-weight: 700; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .full { grid-column: 1 / -1; }
    .qr { display: grid; justify-items: center; gap: 10px; margin: 18px 0; padding: 18px; border-radius: 16px; background: #fff; color: #111; }
    .qr img { width: min(320px, 100%); aspect-ratio: 1; }
    .code { font: 800 26px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .12em; }
    .error { color: #d33; }
    .warn { color: #b97800; }
    .muted { opacity: .62; }
    .action-status { min-height: 20px; margin-top: 9px; font-size: 13px; overflow-wrap: anywhere; }
    .message, .candidate { padding: 12px 0; border-top: 1px solid color-mix(in srgb, CanvasText 10%, transparent); }
    .message:first-child, .candidate:first-child { border-top: 0; }
    .message time, .candidate time { font-size: 12px; opacity: .55; }
    .candidate-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 4px 0; }
    .candidate-title { font-weight: 800; }
    .candidate pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; opacity: .75; }
    .diagnostic-toolbar { display:flex; gap:8px; flex-wrap:wrap; margin:12px 0; }
    .diagnostic-summary { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; font-size:12px; margin:12px 0; }
    .diagnostic-summary > div { padding:9px 10px; border:1px solid color-mix(in srgb,CanvasText 10%,transparent); border-radius:10px; overflow-wrap:anywhere; }
    .logs { border:1px solid color-mix(in srgb,CanvasText 10%,transparent); border-radius:12px; overflow:hidden; }
    .log { display:grid; grid-template-columns:150px 64px minmax(0,1fr); gap:9px; padding:9px 10px; border-top:1px solid color-mix(in srgb,CanvasText 8%,transparent); font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; }
    .log:first-child { border-top:0; }
    .log .level { font-weight:800; text-transform:uppercase; }
    .log.error-log .level { color:#d33; }
    .log.warn-log .level { color:#b97800; }
    .log-details { grid-column:3; opacity:.62; white-space:pre-wrap; overflow-wrap:anywhere; }
    details { margin-top: 18px; }
    summary { cursor: pointer; font-weight: 800; }
    @media (max-width: 680px) { main { padding-top: 30px; } .grid { grid-template-columns: 1fr; } .full { grid-column: auto; } .row { flex-direction: column; } .diagnostic-summary{grid-template-columns:1fr}.log{grid-template-columns:1fr}.log-details{grid-column:1} }
  </style>
</head>
<body>
  <main>
    <div class="top">
      <div class="brand">SOL · WHATSAPP</div>
      <nav><a href="/">Inicio</a><a href="/ai">AI Engine</a></nav>
    </div>
    <h1>WhatsApp familiar.</h1>
    <p>Varias cuentas, cada una con dueño y privacidad propios. Los mensajes se guardan localmente en SOL; sólo candidatos relevantes del tráfico nuevo pasan al motor de razonamiento.</p>
    <section id="app" class="card"><p class="muted">Cargando cuentas…</p></section>
  </main>
<script>
  const app = document.getElementById('app');
  let pollTimer;
  let interactionLock = false;

  function esc(value) {
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

  function stateLabel(state) {
    return ({ idle:'Desconectado', connecting:'Conectando', qr:'Esperando vínculo', open:'Conectado', reconnecting:'Reconectando', error:'Error', logged_out:'Desvinculado' })[state] || state;
  }

  function candidateStatusLabel(status) {
    return ({ pending:'Pendiente', analyzed:'Analizado', ignored:'Ignorado', failed:'Falló' })[status] || status;
  }

  function accountCard(account) {
    const runtime = account.runtime || { state: 'idle' };
    const ownerType = account.ownerMemberId ? 'personal' : 'familiar';
    const qr = account.canManage && runtime.qrDataUrl ? \`
      <div class="qr"><img src="\${esc(runtime.qrDataUrl)}" alt="QR para vincular WhatsApp"><strong>Escaneá desde WhatsApp → Dispositivos vinculados</strong></div>
    \` : '';
    const pairing = account.canManage && runtime.pairingCode ? \`
      <div class="qr"><span>Código de vinculación</span><div class="code">\${esc(runtime.pairingCode)}</div></div>
    \` : '';
    const manage = account.canManage ? \`
      <div class="actions">
        <button data-action="connect" data-id="\${esc(account.id)}">\${runtime.state === 'open' ? 'Reiniciar conexión' : 'Conectar / mostrar QR'}</button>
        <button class="secondary" data-action="pair" data-id="\${esc(account.id)}">Usar código</button>
        \${account.linkedAt ? '<button class="danger" data-action="logout" data-id="' + esc(account.id) + '">Desvincular</button>' : ''}
      </div>
      <div class="action-status" id="action-status-\${esc(account.id)}"></div>
      <div id="pair-\${esc(account.id)}"></div>
    \` : '<p class="muted">Esta cuenta pertenece a otro miembro; su vinculación y contenido privado no están disponibles en tu sesión.</p>';

    return \`
      <article class="card" data-account="\${esc(account.id)}">
        <div class="row">
          <div>
            <h2>\${esc(account.label)}</h2>
            <div class="meta">\${ownerType}\${account.phoneJid ? ' · ' + esc(account.phoneJid) : ''}\${account.displayName ? ' · ' + esc(account.displayName) : ''}</div>
          </div>
          <span class="pill">\${esc(stateLabel(runtime.state))}</span>
        </div>
        \${runtime.lastError ? '<p class="error">' + esc(runtime.lastError) + '</p>' : ''}
        \${qr}\${pairing}\${manage}
        \${account.canManage ? '<details><summary>Diagnóstico / logs de conexión</summary><div data-logs="' + esc(account.id) + '"><p class="muted">Abrí para cargar el diagnóstico.</p></div></details>' : ''}
        \${account.canRead ? \`
          <details><summary>Candidatos detectados por SOL</summary><div data-candidates="\${esc(account.id)}"><p class="muted">Abrí para cargar.</p></div></details>
          <details><summary>Últimos mensajes almacenados</summary><div data-messages="\${esc(account.id)}"><p class="muted">Abrí para cargar.</p></div></details>
        \` : ''}
      </article>
    \`;
  }

  async function loadMessages(accountId, target) {
    const result = await api('/v1/whatsapp/accounts/' + encodeURIComponent(accountId) + '/messages');
    if (!result.response.ok) {
      target.innerHTML = '<p class="error">' + esc(result.body.error || 'No se pudieron leer los mensajes') + '</p>';
      return;
    }
    const messages = result.body.messages || [];
    target.innerHTML = messages.length ? messages.map((m) => \`
      <div class="message"><time>\${esc(new Date(m.occurredAt).toLocaleString())}</time><div>\${esc(m.text || '[mensaje sin texto]')}</div></div>
    \`).join('') : '<p class="muted">Todavía no hay mensajes almacenados.</p>';
  }

  async function loadCandidates(accountId, target) {
    const result = await api('/v1/whatsapp/accounts/' + encodeURIComponent(accountId) + '/candidates');
    if (!result.response.ok) {
      target.innerHTML = '<p class="error">' + esc(result.body.error || 'No se pudieron leer los candidatos') + '</p>';
      return;
    }
    const candidates = result.body.candidates || [];
    target.innerHTML = candidates.length ? candidates.map((c) => {
      const extracted = c.extracted || {};
      const title = extracted.title || c.kind || 'Candidato';
      const summary = extracted.summary || '';
      const confidence = c.confidence == null ? '' : ' · ' + Math.round(Number(c.confidence) * 100) + '%';
      const reasons = (c.reasons || []).join(', ');
      return \`
        <div class="candidate">
          <time>\${esc(new Date(c.occurredAt).toLocaleString())}</time>
          <div class="candidate-head"><span class="pill">\${esc(candidateStatusLabel(c.status))}</span><span class="candidate-title">\${esc(title)}</span><span class="meta">\${esc(c.kind)}\${esc(confidence)}</span></div>
          <div>\${esc(c.text || '')}</div>
          \${summary ? '<p>' + esc(summary) + '</p>' : ''}
          <div class="meta">Filtro local: \${Math.round(Number(c.score || 0) * 100)}% · \${esc(reasons || 'sin motivos')}</div>
          \${c.error ? '<p class="error">' + esc(c.error) + '</p>' : ''}
          \${c.extracted ? '<pre>' + esc(JSON.stringify(c.extracted, null, 2)) + '</pre>' : ''}
        </div>
      \`;
    }).join('') : '<p class="muted">Todavía no hay candidatos. Un mensaje trivial se almacena pero no aparece acá.</p>';
  }

  function diagnosticPlainText(data) {
    const header = [
      'SOL WhatsApp diagnostics',
      'Account: ' + (data.account?.label || data.account?.id || ''),
      'Runtime: ' + (data.runtime?.state || '') + ' / reconnect=' + (data.runtime?.reconnectAttempt || 0),
      'Node: ' + (data.system?.node || '') + ' · ' + (data.system?.platform || '') + ' · ' + (data.system?.arch || ''),
      'Persistence: ' + (data.persistence || ''),
      ''
    ];
    const lines = (data.logs || []).slice().reverse().map((entry) => {
      const details = entry.details ? ' ' + JSON.stringify(entry.details) : '';
      return entry.at + ' [' + String(entry.level || '').toUpperCase() + '] ' + entry.event + ' — ' + entry.message + details;
    });
    return header.concat(lines).join('\\n');
  }

  async function loadLogs(accountId, target) {
    const result = await api('/v1/whatsapp/accounts/' + encodeURIComponent(accountId) + '/logs');
    if (!result.response.ok) {
      target.innerHTML = '<p class="error">' + esc(result.body.error || 'No se pudieron leer los logs') + '</p>';
      return;
    }
    const data = result.body;
    const runtime = data.runtime || {};
    const acc = data.account || {};
    const logs = data.logs || [];
    target.innerHTML = \`
      <p class="muted">Log técnico en memoria: no incluye QR, credenciales ni contenido de mensajes. Se reinicia cuando reiniciás SOL.</p>
      <div class="diagnostic-summary">
        <div><strong>Runtime</strong><br>\${esc(stateLabel(runtime.state))} · intentos \${esc(runtime.reconnectAttempt || 0)}</div>
        <div><strong>Base</strong><br>\${esc(acc.sourceStatus || '—')} · linked \${esc(acc.linkedAt || 'no')}</div>
        <div><strong>Última conexión</strong><br>\${esc(acc.lastConnectionAt || '—')}</div>
        <div><strong>Entorno</strong><br>\${esc(data.system?.node || '')} · \${esc(data.system?.platform || '')} / \${esc(data.system?.arch || '')}</div>
      </div>
      \${runtime.lastError ? '<p class="error"><strong>Último error:</strong> ' + esc(runtime.lastError) + '</p>' : ''}
      \${acc.lastError && acc.lastError !== runtime.lastError ? '<p class="error"><strong>Error persistido:</strong> ' + esc(acc.lastError) + '</p>' : ''}
      <div class="diagnostic-toolbar"><button class="secondary" data-log-copy="\${esc(accountId)}">Copiar diagnóstico</button><button class="secondary" data-log-refresh="\${esc(accountId)}">Actualizar logs</button><button class="danger" data-log-clear="\${esc(accountId)}">Limpiar logs</button></div>
      <div class="logs">\${logs.length ? logs.map((entry) => {
        const details = entry.details ? JSON.stringify(entry.details, null, 2) : '';
        return '<div class="log ' + esc(entry.level) + '-log"><time>' + esc(new Date(entry.at).toLocaleString()) + '</time><span class="level">' + esc(entry.level) + '</span><div><strong>' + esc(entry.event) + '</strong><br>' + esc(entry.message) + '</div>' + (details ? '<div class="log-details">' + esc(details) + '</div>' : '') + '</div>';
      }).join('') : '<p class="muted" style="padding:12px">Todavía no hay eventos de diagnóstico.</p>'}</div>
    \`;
    const copy = target.querySelector('[data-log-copy]');
    if (copy) copy.onclick = async () => {
      try { await navigator.clipboard.writeText(diagnosticPlainText(data)); copy.textContent = 'Copiado'; }
      catch { copy.textContent = 'No se pudo copiar'; }
    };
    const refresh = target.querySelector('[data-log-refresh]');
    if (refresh) refresh.onclick = () => loadLogs(accountId, target);
    const clear = target.querySelector('[data-log-clear]');
    if (clear) clear.onclick = async () => {
      await api('/v1/whatsapp/accounts/' + encodeURIComponent(accountId) + '/logs', { method:'DELETE' });
      await loadLogs(accountId, target);
    };
  }

  function showActionError(id, message) {
    const status = document.getElementById('action-status-' + id);
    if (!status) return;
    status.className = 'action-status error';
    status.textContent = message;
  }

  function bindActions() {
    document.querySelectorAll('[data-action="connect"]').forEach((button) => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        const id = button.dataset.id;
        const account = document.querySelector('[data-account="' + id + '"]');
        const state = account?.querySelector('.pill')?.textContent;
        const endpoint = state === 'Conectado' ? 'restart' : 'connect';
        const result = await api('/v1/whatsapp/accounts/' + encodeURIComponent(id) + '/' + endpoint, { method:'POST' });
        if (!result.response.ok) {
          showActionError(id, result.body.error || ('Error de conexión HTTP ' + result.response.status));
          button.disabled = false;
          const logs = account?.querySelector('[data-logs]');
          if (logs) await loadLogs(id, logs);
          return;
        }
        await load();
      });
    });

    document.querySelectorAll('[data-action="pair"]').forEach((button) => {
      button.addEventListener('click', () => {
        interactionLock = true;
        clearTimeout(pollTimer);
        const id = button.dataset.id;
        const slot = document.getElementById('pair-' + id);
        slot.innerHTML = \`
          <div class="grid" style="margin-top:14px">
            <label class="full">Número con código de país (sólo dígitos)
              <input id="phone-\${esc(id)}" inputmode="numeric" placeholder="549..." />
            </label>
          </div>
          <button class="secondary" id="pair-submit-\${esc(id)}">Generar código</button>
          <div id="pair-status-\${esc(id)}"></div>
        \`;
        document.getElementById('pair-submit-' + id).addEventListener('click', async () => {
          const phoneNumber = document.getElementById('phone-' + id).value;
          const status = document.getElementById('pair-status-' + id);
          status.textContent = 'Generando…';
          const result = await api('/v1/whatsapp/accounts/' + encodeURIComponent(id) + '/pairing-code', {
            method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({phoneNumber})
          });
          if (!result.response.ok) {
            status.innerHTML = '<p class="error">' + esc(result.body.error || 'No se pudo generar') + '</p>';
            const account = document.querySelector('[data-account="' + id + '"]');
            const logs = account?.querySelector('[data-logs]');
            if (logs) await loadLogs(id, logs);
          } else {
            interactionLock = false;
            await load();
          }
        });
      });
    });

    document.querySelectorAll('[data-action="logout"]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (!confirm('¿Desvincular esta cuenta de WhatsApp de SOL? Se borrarán las credenciales de linked-device, pero no el historial ya almacenado.')) return;
        button.disabled = true;
        const result = await api('/v1/whatsapp/accounts/' + encodeURIComponent(button.dataset.id) + '/logout', { method:'POST' });
        if (!result.response.ok) {
          showActionError(button.dataset.id, result.body.error || 'No se pudo desvincular');
          button.disabled = false;
          return;
        }
        await load();
      });
    });

    document.querySelectorAll('details').forEach((details) => {
      details.addEventListener('toggle', () => {
        if (!details.open || details.dataset.loaded) return;
        details.dataset.loaded = '1';
        const messages = details.querySelector('[data-messages]');
        const candidates = details.querySelector('[data-candidates]');
        const logs = details.querySelector('[data-logs]');
        if (messages) void loadMessages(messages.dataset.messages, messages);
        if (candidates) void loadCandidates(candidates.dataset.candidates, candidates);
        if (logs) void loadLogs(logs.dataset.logs, logs);
      });
    });

    const refresh = document.getElementById('refresh');
    if (refresh) refresh.addEventListener('click', async () => {
      interactionLock = false;
      refresh.disabled = true;
      await load();
    });
  }

  async function load() {
    if (interactionLock) return;
    clearTimeout(pollTimer);
    const [me, accountsResult] = await Promise.all([api('/v1/auth/me'), api('/v1/whatsapp/accounts')]);
    if (!me.response.ok) {
      app.innerHTML = '<h2>Necesitás iniciar sesión</h2><p><a href="/">Volver al inicio</a></p>';
      return;
    }
    if (!accountsResult.response.ok) {
      app.innerHTML = '<p class="error">' + esc(accountsResult.body.error || 'No se pudieron cargar las cuentas') + '</p>';
      return;
    }

    const member = me.body.member;
    const accounts = accountsResult.body.accounts || [];
    const canAdd = !['child','guest'].includes(member.role);
    const canShared = ['owner','adult'].includes(member.role);

    app.innerHTML = \`
      <div class="row"><div><h2>Cuentas vinculables</h2><div class="meta">Sesión SOL: \${esc(member.displayName)} · \${esc(member.role)}</div></div><div class="actions" style="margin-top:0"><span class="pill">\${accounts.length} cuenta(s)</span><button class="secondary" id="refresh">Actualizar</button></div></div>
      \${canAdd ? \`
        <details open>
          <summary>Agregar cuenta</summary>
          <form id="new-account" style="margin-top:14px">
            <div class="grid">
              <label>Nombre
                <input name="label" value="WhatsApp personal" maxlength="120" required />
              </label>
              \${canShared ? '<label>Propiedad<select name="shared"><option value="false">Personal</option><option value="true">Familiar compartida</option></select></label>' : ''}
            </div>
            <button type="submit">Crear cuenta</button>
            <span id="new-status" class="meta"></span>
          </form>
        </details>
      \` : ''}
      <div class="accounts">\${accounts.map(accountCard).join('') || '<p class="muted">Todavía no agregaste ninguna cuenta de WhatsApp.</p>'}</div>
      <p class="muted">WhatsApp se conecta como dispositivo vinculado mediante Baileys, una integración no oficial. No uses este conector para spam o mensajería masiva.</p>
    \`;

    const form = document.getElementById('new-account');
    if (form) form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      const status = document.getElementById('new-status');
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      status.className = 'meta';
      status.textContent = 'Creando…';
      const result = await api('/v1/whatsapp/accounts', {
        method:'POST', headers:{'content-type':'application/json'},
        body:JSON.stringify({label:data.label, shared:data.shared === 'true'})
      });
      if (!result.response.ok) {
        status.className = 'action-status error';
        status.textContent = result.body.error || ('Error HTTP ' + result.response.status);
        submit.disabled = false;
      } else await load();
    });

    bindActions();
    const waiting = accounts.some((a) => ['connecting','qr','reconnecting'].includes(a.runtime?.state));
    if (waiting) pollTimer = setTimeout(load, 1500);
  }

  load();
</script>
</body>
</html>`;
}
