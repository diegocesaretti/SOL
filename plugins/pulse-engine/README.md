# SOL Pulse Engine · MVP 0.1

Plugin aislado de ingreso, deduplicación y priorización de eventos. No envía mensajes ni acciona dispositivos.

- Instalación `autoStart: false`, producción intacta.
- Persistencia atómica `SOL_PLUGIN_DATA_DIR/pulse-events.json`.
- Herramientas MCP: `pulse_status` (read), `pulse_events` (read), `pulse_ingest_event` (submit), `pulse_decisions` (read).
- Sólo ingesta autenticada mediante el callback de SOL MCP (no API pública de ingesta).
- Las consultas nunca devuelven payload, sólo metadatos mínimos.
- Evaluación heurística inicial de prioridad, `review` / `digest` / `ignore`; no envío automático.
- Pendiente: productores reales de eventos, motor IA contextual, consentimiento granular, canal de entrega confiable y UI.

Pruebas: `node --check plugins/pulse-engine/index.mjs` y `node --test plugins/pulse-engine/test.mjs`.
