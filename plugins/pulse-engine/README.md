# SOL Pulse Engine (MVP 0.2)

Servicio Node de eventos proactivos con almacenamiento durable, deduplicación, prioridad y decisiones. No ejecuta acciones y **no envía WhatsApp**.

## Fuentes

- Mercado Libre: eventos enviados por BWA 3D mediante HTTP loopback autenticado (`127.0.0.1`).
- El diseño admite otras fuentes, pero todavía no tienen productores residentes conectados.

## Configuración

- Plugin Pulse: `PULSE_ENGINE_API_PORT=8794`.
- En ambos plugins, configurar **el mismo token aleatorio de 32+ caracteres**, como `PULSE_ENGINE_INGEST_TOKEN` en Pulse y `BWA3D_PULSE_TOKEN` en BWA.
- En ambos plugins, configurar **el mismo ownerId autorizado**: `PULSE_ENGINE_INGEST_OWNER_ID` en Pulse y `BWA3D_PULSE_OWNER_ID` en BWA.
- BWA debe tener `BWA3D_PULSE_ENABLED=true`. La opción está desactivada de forma predeterminada.
- BWA publica en `BWA3D_PULSE_ENDPOINT=http://127.0.0.1:8794/v1/ingest`, intervalo `BWA3D_PULSE_POLL_MS=180000`.
- No configurar secrets en el código ni en Git; usar los ajustes secretos del gestor de plugins.

Pulse tiene `autoStart=false` hasta que se valide su configuración. El endpoint solo escucha en loopback y rechaza eventos sin token, fuente distinta a Mercado Libre u ownerId no autorizado.

## API y herramientas

- `GET /health`: salud y conteos.
- `POST /v1/ingest`: ingesta local autenticada para BWA; propietario y fuente restringidos.
- MCP: `pulse_status`, `pulse_events`, `pulse_decisions`, `pulse_ingest_event`.
- Las consultas devuelven solo metadatos con títulos privados redactados.

## Semántica Mercado Libre

La primera consulta de pedidos crea una línea base sin generar eventos de ventas anteriores. Después, cada alta de pedido y cambio de estado produce un evento, con prioridad mayor para cancelaciones. BWA envía primero y registra el checkpoint después: al fallar Pulse, reintenta en la siguiente pasada. Pulse usa clave de idempotencia para no duplicar.

Límite actual: se leen hasta 100 pedidos por iteración y los cambios de pedidos más antiguos pueden no detectarse; la futura versión debería utilizar notificaciones oficiales y reconciliación por páginas. No se almacenan datos del comprador. El motor es heurístico y todavía no razona con IA.

## Pruebas

`node --test plugins/pulse-engine/*.test.mjs plugins/bwa-3d/pulse-publisher.test.mjs`

La prueba de integración inicia Pulse en un puerto temporal, intenta accesos no autorizados, simula pedidos y valida persistencia y deduplicación con envío real **deshabilitado**.

## Próximos pasos

1. Instalar/activar por el gestor SOL, aplicar token y ownerId mediante configuraciones seguras.
2. Verificar ingestion real por un ciclo; vigilar la salud de ambos plugins.
3. Desarrollar entregas confiables con recibos de WhatsApp, preferencias y consentimiento por miembro.
4. Complementar con Home Assistant, educación, finanzas, calendario, correo, clima y noticias.
