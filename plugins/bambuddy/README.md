# Bambuddy SOL plugin

Integración nativa de Bambuddy para SOL.

## Funciones

- estado y control de impresoras Bambu configuradas en Bambuddy;
- listado persistente de archivos SD con caché de 24 horas y refresh en vivo;
- impresión directa de archivos `.3mf` ya presentes en la raíz de la SD;
- fallback de impresión para clientes con catálogo MCP viejo: los listados incluyen una ruta alternativa mediante `bambuddy_api_action` + `/print-sd`;
- acceso de lectura al OpenAPI de Bambuddy;
- fallback genérico de lectura/acción para endpoints `/api/v1/`;
- verificación y reparación idempotente de dos parches de compatibilidad de Bambuddy.
- Obico ML nativo administrado por el plugin, con GPU NVIDIA, watchdog y bootstrap reproducible sin Docker.

## Parches mantenidos

El plugin inspecciona `app/backend/app/api/routes/printers.py` dentro de la instalación de Bambuddy.

1. **Model Files fallback**: si `/model` no está disponible en una A1/A1 Mini, usa la raíz de la SD para el listado.
2. **Direct SD print**: agrega `POST /api/v1/printers/{printer_id}/print-sd`, que valida el archivo y delega en el `printer_manager.start_print()` existente de Bambuddy.

El setting **Mantener parches de Bambuddy aplicados** está activo por defecto. En cada arranque sólo inspecciona. Si los parches desaparecieron tras una actualización, prepara un archivo parcheado y solicita elevación UAC para reemplazar `printers.py`. Antes de escribir crea backup. Si los anclajes del Bambuddy nuevo no coinciden, falla cerrado y no modifica nada.

También expone:

- `bambuddy_patch_status` (read)
- `bambuddy_patch` (actions, requiere confirmación explícita de SOL)

Los backups y estados viven en `SOL_PLUGIN_DATA_DIR`, fuera del paquete del plugin.

## Reinstalación

El plugin se publica como `Bambuddy.solplugin` en el release `bambuddy-plugin-latest` del repositorio `diegocesaretti/SOL`.

SOL conserva settings y `plugin-data` al actualizar/reinstalar en el lugar. No se versionan códigos de acceso de impresoras, API keys, cachés ni otros secretos.
## Obico ML nativo

El plugin puede administrar un ML API de Obico nativo para Windows en `SOL_PLUGIN_DATA_DIR/obico-ml`. El código del plugin fija el commit upstream, el modelo ONNX y su SHA-256, las dependencias GPU y los dos parches mínimos de compatibilidad Windows. El modelo y CUDA no se guardan en GitHub: `obico-ml/bootstrap.ps1` los reconstruye y verifica.

El runtime se enlaza a `127.0.0.1:3333`, usa ONNX Runtime GPU/CUDA cuando está disponible y queda supervisado por el plugin. Bambuddy conserva su propia sensibilidad/acción; el plugin sólo asegura que la integración esté habilitada y apunte al ML local.
