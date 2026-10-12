# SOL Pulse Engine 0.7.0 · Panorama-first

Motor proactivo residente para SOL. Está preparado para funcionar como plugin SOL independiente, pero requiere instalación y autorización mediante el gestor oficial.

## Fuentes

- **Mercado Libre**: BWA 3D 0.2.2 reutiliza su sesión de vendedor y publica pedidos nuevos y cambios relevantes. La primera lectura establece una línea base sin crear avisos retrospectivos.
- **Finanzas**: Pulse consulta `finanzas_vencimientos_list` por la API MCP interna de SOL (`mcp.invoke.read`). Emite eventos para vencimientos activos a 2 días, 1 día, hoy y vencidos ayer. No publica importes ni datos de factura.
- **Home Assistant**: consulta entidades seleccionadas desde el caché por `home_assistant_get_state` y compara cambios contra un checkpoint persistente. En el primer relevamiento no emite avisos viejos. La lista explícita admite solo climate, switch, light, sensor y binary_sensor; excluye person, device_tracker y cámaras.

## Notificaciones

- Se requiere opt-in con `PULSE_DELIVERY_ENABLED=true` y número de destino validado.
- Incidentes importantes se notifican individualmente; los de prioridad media se agrupan en resúmenes.
- Máximo 8 avisos al día, silencios 22:00–07:00 en Córdoba. Excepción: alertas críticas de Home Assistant si una entidad de seguridad autorizada cambia a "on".
- Se registra el intento antes de contactar a Nexo; al confirmar Nexo pasa a estado `accepted`. Si hay incertidumbre se deja `uncertain` para revisión y no se reintenta ciegamente.
- `accepted` significa aceptado por Nexo, no entregado ni leído en el teléfono.
- No se ejecutan acciones sobre equipos, impresoras, publicaciones ni pagos.

## Configuración

Pulse: `PULSE_ENGINE_API_PORT` (8794), `PULSE_ENGINE_INGEST_TOKEN` (secreto compartido de 32+ caracteres), `PULSE_ENGINE_INGEST_OWNER_ID`, `PULSE_DELIVERY_ENABLED` (false), `PULSE_WHATSAPP_TO`, `PULSE_NEXO_PORT` (3210), `PULSE_FINANCE_ENABLED` (false), `PULSE_HOME_ENABLED` (false), `PULSE_HOME_ENTITIES` (cadena de entidades separadas por coma).

BWA: `BWA3D_PULSE_ENABLED` (false), `BWA3D_PULSE_ENDPOINT=http://127.0.0.1:8794/v1/ingest`, `BWA3D_PULSE_TOKEN` (igual secreto de Pulse), `BWA3D_PULSE_OWNER_ID` (igual ownerId), `BWA3D_PULSE_POLL_MS` (180000).

Al instalar Pulse, el gestor oficial debe autorizar explícitamente `mcp.register`, `filesystem.plugin-data`, `network.local` y `mcp.invoke.read`. El permiso de lectura MCP está limitado por SOL al miembro propietario del plugin y nunca permite escrituras en Finanzas ni en Home Assistant.

## Diagnóstico

- `GET http://127.0.0.1:8794/health`: eventos, decisiones, envío, errores de fuentes y disponibilidad.
- `GET http://127.0.0.1:8781/health`: estado del publicador BWA 3D en `pulsePublisher`.
- MCP: `pulse_status`, `pulse_events`, `pulse_decisions`, `pulse_ingest_event`.
- Consulta y audita `uncertain` cuando Nexo no devuelve una aceptación inequívoca.

## Pruebas

```powershell
node --test plugins/pulse-engine/*.test.mjs plugins/bwa-3d/pulse-publisher.test.mjs
```

El conjunto cubre ingestión HTTP autenticada, primera línea base, deduplicación, error de entrega, límites de entidades de hogar, lectura financiera, privacidad, horarios y envío a Nexo simulado.

## Límites actuales

- No está instalado en la instancia productiva de SOL solo por estar en el repositorio.
- Mercado Libre se consulta por polling hasta 100 pedidos recientes; falta webhook y reconciliación paginada.
- Clasificación determinista, todavía sin un motor LLM de evaluación contextual.
- No existe una capa de permisos por destinatario distinta de la identidad propietaria.
- Clima, calendario, noticias y correo aún requieren conectores específicos.
- No debe sustituir sistemas de alarma certificados o avisos de emergencia existentes.

## Entrega autorizada mediante Nexo 0.11.7

Pulse 0.6.0 **no usa** el endpoint manual `/api/output/send` ni envía `confirmedByUser=true` en mensajes automáticos. Utiliza el endpoint dedicado `/api/automation/pulse/send`, que exige autorización persistente explícita en Nexo.

Configurar, además de las opciones anteriores:
- En Pulse: `PULSE_NEXO_AUTOMATION_TOKEN` (secreto de 32+ caracteres).
- En Nexo: `NEXO_PULSE_ENABLED=true`, `NEXO_PULSE_TOKEN` (el mismo token), `NEXO_PULSE_TO` (el mismo número que `PULSE_WHATSAPP_TO`).
- Nexo verifica también que ese número esté en su lista OUTPUT autorizada.

El token de autorización para Nexo es distinto del token usado entre BWA 3D y Pulse para publicar eventos. Ambos se guardan como ajustes secretos en el gestor de SOL. Sin esta concesión explícita, las notificaciones permanecen inactivas.

La protección en Nexo aplica clave de idempotencia por evento, evita envíos concurrentes duplicados y limita a 12 notificaciones diarias. Pulse mantiene un máximo propio de 8. Los informes de estado solamente indican aceptación por Nexo, nunca confirmación de lectura.

## Integración Panorama-first (v0.7.0)

- SOL 0.15.27 conserva ediciones diarias por miembro de Panorama. El runtime con token propio de Pulse consulta exclusivamente ediciones del integrante autorizado mediante `GET /v1/plugin-api/panorama/latest`.
- La primera consulta crea un checkpoint sin volver a avisar por hechos antiguos. Nuevas ediciones con novedades se investigan hasta 2 por ciclo mediante `POST /v1/plugin-api/panorama/investigate`.
- Codex elige como máximo dos herramientas MCP de **lectura** autorizadas para ese miembro; luego sintetiza evidencia verificada, incertidumbres y próximos pasos. No tiene acceso a herramientas `actions` ni a otro integrante.
- Pulse persiste las oportunidades y reutiliza el notificador de Nexo autorizado, con deduplicación, horario silencioso y cuota diaria. Aún no existe despacho diferenciado por integrante: solo se permite el número previamente autorizado del propietario.
- Activación explícita: `PULSE_PANORAMA_ENABLED=true` y permiso `mcp.invoke.read`; por defecto desactivado. Se conserva el canal independiente de Home Assistant para alarmas críticas.
- No se ejecutan cambios en calendario, pagos, equipos ni publicaciones. Los próximos pasos son propuestas que requieren consentimiento.
- Hasta instalar esta versión de SOL y Pulse, las nuevas rutas y el polling de Panorama no están activos en producción.
