# Finanzas SOL plugin

Plugin local para mantener un registro estructurado de vencimientos y documentación financiera detectada por SOL.

## Arquitectura

El plugin **no replica OAuth de Google**. Gmail, Drive y Calendar siguen siendo operados por los conectores externos disponibles para el agente. Finanzas mantiene el estado determinístico y las referencias cruzadas:

- emisor, concepto, período, importe, moneda y vencimiento;
- estado `detected`, `scheduled`, `paid` o `dismissed`;
- `gmailMessageId` / `gmailThreadId`;
- `driveFileId` y ubicación lógica del documento archivado;
- `calendarEventId`;
- referencia al comprobante de pago cuando exista;
- fingerprint para deduplicación.

Los documentos originales deben quedar en Google Drive. El plugin no guarda el contenido completo de facturas ni resúmenes.

## Flujo esperado

1. SOL Pulse detecta en Gmail una factura o resumen con vencimiento.
2. Lee el cuerpo y, si corresponde, el adjunto.
3. Extrae metadatos con alta confianza.
4. Archiva el documento en `SOL/Finanzas/...` usando Google Drive.
5. Busca/crea el evento de vencimiento en Google Calendar.
6. Llama `finanzas_vencimiento_upsert` y enlaza Gmail + Drive + Calendar.
7. Si posteriormente aparece un comprobante o confirmación de pago, llama `finanzas_vencimiento_marcar_pagado`.

## Herramientas MCP

- `finanzas_status`
- `finanzas_vencimientos_list`
- `finanzas_vencimiento_get`
- `finanzas_resumen`
- `finanzas_vencimiento_upsert`
- `finanzas_vencimiento_link`
- `finanzas_vencimiento_marcar_pagado`
- `finanzas_vencimiento_descartar`

Las mutaciones usan scope `submit` y requieren autorización de usuario. Una automatización creada explícitamente por el usuario puede transportar esa autorización como política permanente acotada.

## Persistencia

El estado se almacena dentro de `SOL_PLUGIN_DATA_DIR/finanzas.json`; nunca dentro del árbol de código del plugin.
