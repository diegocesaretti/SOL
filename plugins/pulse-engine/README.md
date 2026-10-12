# SOL Pulse Engine 0.3.0

Motor proactivo residente, con events, deduplicación persistente, clasificación heurística y notificación WhatsApp opcional.

## Arquitectura

- BWA 3D 0.2.1 consulta la API ya autenticada de Mercado Libre cada 3 minutos.
- La primera consulta establece una línea base: no genera alertas por pedidos pasados.
- Los pedidos nuevos y cambios de estado generan eventos con claves idempotentes vía HTTP local autenticado.
- Pulse archiva estado (JSON con escritura atómica) y expone `pulse_status`, `pulse_events`, `pulse_decisions` y `pulse_ingest_event`.
- Eventos de prioridad >=80 generan un aviso individual. Eventos de prioridad media se agregan en resúmenes (08, 12 y 18, hora de Córdoba).
- Máximo 8 avisos/día, silencio entre 22 y 07, sólo al WhatsApp explícitamente configurado para el propietario.
- Los mensajes no incluyen datos privados ni información de compradores.
- Se marca estado `sending` antes del HTTP a Nexo, y `accepted` después de que Nexo confirma envío. Ante error se marca `uncertain` y se evita el reenvío automático que podría duplicar mensajes.
- `accepted` no representa prueba de lectura o entrega en el teléfono: sólo aceptación por Nexo.

## Ajustes

Pulse: `PULSE_ENGINE_API_PORT` (8794), `PULSE_ENGINE_INGEST_TOKEN` (secreto), `PULSE_ENGINE_INGEST_OWNER_ID`, `PULSE_DELIVERY_ENABLED`, `PULSE_WHATSAPP_TO`, `PULSE_NEXO_PORT` (3210).
BWA: `BWA3D_PULSE_ENABLED`, `BWA3D_PULSE_ENDPOINT`, `BWA3D_PULSE_TOKEN`, `BWA3D_PULSE_OWNER_ID`, `BWA3D_PULSE_POLL_MS`.

Ambos plugins deben compartir token de 32+ caracteres y ownerId autorizado; ninguna credencial OAuth de Mercado Libre se copia a Pulse. Todos los datos quedan restringidos al host y al propietario configurado.

## Estado funcional y límites

- Activación independiente y con permisos. No controla impresoras, precios, publicaciones ni dispositivos.
- Prioridades heurísticas: todavía no razona con un LLM ni correlaciona fuentes externas.
- La detección de cambios se limita a los 100 pedidos más recientes en cada ciclo. Los pedidos antiguos fuera de esa ventana y picos masivos requieren reconciliación adicional o webhook oficial.
- Si Nexo acepta un mensaje pero la conexión se corta antes de responder, el evento queda `uncertain` para revisión y no se reenvía a ciegas.
- Home Assistant, calendario, clima, correos, noticias, educación y finanzas están contemplados como fuentes futuras, pero aún no conectados como productores residentes.

Pruebas: `node --test plugins/pulse-engine/*.test.mjs plugins/bwa-3d/pulse-publisher.test.mjs`.
