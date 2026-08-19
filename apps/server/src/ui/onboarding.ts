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
    main { width: min(720px, calc(100% - 32px)); margin: 0 auto; padding: 64px 0; }
    .brand { font-size: 14px; font-weight: 800; letter-spacing: .18em; opacity: .7; }
    h1 { margin: 12px 0 8px; font-size: clamp(36px, 7vw, 64px); letter-spacing: -.04em; }
    h2 { margin: 0 0 8px; font-size: 24px; }
    p { line-height: 1.55; opacity: .8; }
    .card { margin-top: 32px; padding: 28px; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 22px; background: color-mix(in srgb, Canvas 96%, CanvasText 4%); }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    label { display: grid; gap: 7px; font-size: 13px; font-weight: 700; }
    label.full { grid-column: 1 / -1; }
    input { width: 100%; padding: 12px 14px; border-radius: 12px; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); background: Canvas; color: CanvasText; font: inherit; }
    button { margin-top: 22px; padding: 12px 18px; border: 0; border-radius: 999px; font: inherit; font-weight: 800; cursor: pointer; background: CanvasText; color: Canvas; }
    button:disabled { opacity: .45; cursor: wait; }
    .status { margin-top: 14px; min-height: 20px; font-size: 14px; }
    .error { color: #d33; }
    .muted { opacity: .62; }
    .pill { display: inline-flex; align-items: center; gap: 8px; padding: 7px 11px; border-radius: 999px; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); font-size: 13px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #2ca44f; }
    .household { display: flex; justify-content: space-between; gap: 20px; align-items: center; padding: 16px 0; border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent); }
    .household:first-of-type { border-top: 0; }
    @media (max-width: 620px) { main { padding: 36px 0; } .grid { grid-template-columns: 1fr; } label.full { grid-column: auto; } .card { padding: 22px; } }
  </style>
</head>
<body>
  <main>
    <div class="brand">SOL</div>
    <h1>Tu hogar, conectado.</h1>
    <p id="intro">Configurando el núcleo familiar de SOL…</p>
    <section class="card" id="app"><p class="muted">Cargando estado del sistema…</p></section>
  </main>
  <script>
    const app = document.getElementById('app');
    const intro = document.getElementById('intro');

    function escapeHtml(value) {
      return String(value).replace(/[&<>'"]/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;'
      })[char]);
    }

    function configuredView(state) {
      intro.textContent = 'SOL ya tiene un hogar configurado. Las próximas integraciones se sumarán a este mismo núcleo.';
      const households = state.households.map((household) => \`
        <div class="household">
          <div>
            <strong>\${escapeHtml(household.name)}</strong><br />
            <span class="muted">\${escapeHtml(household.timezone)} · \${household.memberCount} miembro(s)</span>
          </div>
          <span class="pill"><span class="dot"></span>Activo</span>
        </div>
      \`).join('');
      app.innerHTML = \`
        <h2>SOL está listo</h2>
        <p>La identidad familiar y la base persistente ya están inicializadas.</p>
        \${households}
        <p class="muted">Siguiente etapa: autenticación de Codex y gestión de fuentes.</p>
      \`;
    }

    function onboardingView() {
      intro.textContent = 'Primero definimos el hogar y a la primera persona administradora. Después iremos conectando fuentes y miembros.';
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const locale = navigator.language || 'es-AR';
      app.innerHTML = \`
        <h2>Crear hogar</h2>
        <p>Esto crea el espacio familiar base. No conecta todavía WhatsApp, Google ni Codex.</p>
        <form id="setup-form">
          <div class="grid">
            <label class="full">Nombre del hogar
              <input name="householdName" autocomplete="organization" placeholder="Familia" required maxlength="120" />
            </label>
            <label>Tu nombre
              <input name="ownerName" autocomplete="name" placeholder="Nombre" required maxlength="120" />
            </label>
            <label>Zona horaria
              <input name="timezone" value="\${escapeHtml(timezone)}" required maxlength="100" />
            </label>
          </div>
          <input type="hidden" name="ownerLocale" value="\${escapeHtml(locale)}" />
          <button type="submit">Crear SOL Home</button>
          <div class="status" id="status"></div>
        </form>
      \`;

      const form = document.getElementById('setup-form');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('button');
        const status = document.getElementById('status');
        button.disabled = true;
        status.className = 'status';
        status.textContent = 'Creando hogar…';

        const data = Object.fromEntries(new FormData(form).entries());
        try {
          const response = await fetch('/v1/onboarding', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(data),
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'No se pudo crear el hogar');
          await load();
        } catch (error) {
          status.className = 'status error';
          status.textContent = error.message;
          button.disabled = false;
        }
      });
    }

    async function load() {
      try {
        const response = await fetch('/v1/onboarding', { cache: 'no-store' });
        const state = await response.json();
        if (!response.ok) throw new Error(state.error || 'No se pudo consultar SOL');
        if (state.configured) configuredView(state);
        else onboardingView();
      } catch (error) {
        intro.textContent = 'SOL no pudo consultar su base de datos.';
        app.innerHTML = \`<h2>Base no disponible</h2><p class="error">\${escapeHtml(error.message)}</p><p class="muted">Verificá PostgreSQL y ejecutá las migraciones.</p>\`;
      }
    }

    load();
  </script>
</body>
</html>`;
}
