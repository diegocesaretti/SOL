# SOL Agent ↔ Nexo · canal WhatsApp experimental (v0.5.0)

La integración utiliza el **trabajador residente y la cuenta OUTPUT existentes en Nexo**; no crea un segundo bot ni importa credenciales Baileys a SOL Agent.

## Recibir instrucciones de WhatsApp

Nexo `feature/sol-agent-nexo-channel` reconoce comandos **literales** `/agente` antes de invocar Codex y solamente si:
1. `NEXO_SOL_AGENT_COMMANDS_ENABLED=true` (por defecto falso).
2. El número del mensaje OUTPUT, sin grupos, coincide con el **número propietario fijo** `NEXO_SOL_AGENT_OWNER_PHONE`.
3. Ese número permanece autorizado para el canal OUTPUT y vinculado a una identidad Nexo con rol `owner` y `codexConversationEnabled=true`.
4. Nexo tiene token runtime emitido por SOL y el permiso explícitamente aprobado `mcp.invoke.submit`.
5. El Core instalado incluye el puente de [SOL PR #119](https://github.com/diegocesaretti/SOL/pull/119), que comprueba adicionalmente que el miembro del token es **propietario activo del mismo hogar**.

Comandos soportados:
- `/agente misiones` y `/agente propuestas` (solo consulta).
- `/agente crear negocio Investigar faltantes de stock y cuellos de botella de producción.`
- `/agente crear hogar Investigar anomalías persistentes de climatización sin controlar los aires.`
- `/agente pausar mission-abc123` y `/agente reanudar mission-abc123`
- `/agente despertar mission-abc123`
- `/agente evaluar mission-abc123 <proposal-uuid> útil|irrelevante|incorrecto`

No hay comandos para controlar Home Assistant, cambiar Mercado Libre, enviar WhatsApp, pagar, imprimir o delegar herramientas sin límites. Los comandos no se exponen como herramientas al modelo Codex de Nexo: solo los analiza un parser determinista que recibe el **texto nuevo del remitente autorizado**, no mensajes recuperados de otros chats.

## Avisos por iniciativa de SOL Agent

Se añadió un **canal separado** del Morning Brief en Nexo:
`POST http://127.0.0.1:3210/api/automation/sol-agent/notify`.

Requisitos simultáneos:
- En SOL Agent: `SOL_AGENT_AUTONOMY_ENABLED=true`, `SOL_AGENT_NEXO_NOTIFICATIONS_ENABLED=true`, `SOL_AGENT_NEXO_NOTIFY_TOKEN` y `SOL_AGENT_NEXO_URL` de loopback.
- En Nexo: `NEXO_SOL_AGENT_NOTIFY_ENABLED=true`, `NEXO_SOL_AGENT_NOTIFY_TOKEN` (idéntico al anterior, al menos 24 caracteres, configurado como **secreto**), y `NEXO_SOL_AGENT_OWNER_PHONE`.
- Nexo requiere OUTPUT habilitado, identidad propietaria y número autorizado. El agente **nunca** decide ni transmite el destinatario.
- Solo hallazgos de `priority=high`, `confidence>=0.8`, evidencia de fuentes verificadas, no corregidos como irrelevantes o incorrectos, y publicados dentro de las últimas cuatro horas.
- Ventana horaria Nexo 08:00–20:59 de Argentina. Un máximo de **un aviso proactivo al día**, deduplicado mediante la auditoría persistente de Nexo; SOL Agent guarda otro checkpoint de entrega para evitar reintentos repetidos.
- Si el permiso está desactivado, falta el token o Nexo no está disponible, **no se envía nada**. Nexo nunca emplea el token de Morning Brief para este flujo.

El endpoint admite únicamente loopback, token específico y texto acotado; no acepta parámetros de destinatario, ni `confirmedByUser` falso para envío libre. Las respuestas a comandos explícitos siguen utilizando `replyToOutputConversationMessage` (asociado al mensaje original y remitente fijo).

## Orden de integración y riesgos pendientes

PRs separados para revisar y probar:
1. [SOL Core #118](https://github.com/diegocesaretti/SOL/pull/118): Codex de SOL para razonamiento del agente.
2. [SOL Core #119](https://github.com/diegocesaretti/SOL/pull/119): gestión de misiones desde Nexo, aislada del MCP de acciones y con permiso `mcp.invoke.submit`.
3. [Nexo #42](https://github.com/diegocesaretti/Whatsapp-Codex-Nexo/pull/42): parser, validación de remitente, respuestas y canal de avisos proactivos.
4. [SOL Agent #117](https://github.com/diegocesaretti/SOL/pull/117): misiones persistentes y publicador Nexo.

No fusionar ni instalar ninguno por separado. **Prueba completa en entorno aislado antes de producción:** cuenta OUTPUT real autorizada, confirmación de identidad y miembro SOL, tolerancia ante reinicios, prueba de duplicados en modo concurrente, validación de permisos y revisión de privacidad. Los cambios de WhatsApp externos implican riesgo de entrega, así que nunca habilitarlos automáticamente.

**Estado:** código experimental y pruebas automatizadas, todo apagado de origen; no envía mensajes reales ni altera el HTPC.
