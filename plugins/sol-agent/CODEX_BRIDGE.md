# SOL Agent 0.4 — Reutilizar Codex de SOL (PR #117 + PR #118)

## Arquitectura

La ruta predeterminada del agente es:

SOL Agent (misiones duraderas y elección de herramientas) -> `POST /v1/plugin-api/ai/reason` -> SOL Core -> `CodexProvider.reason()` -> Codex App Server autenticado con la cuenta ChatGPT conectada a SOL.

Esto **no** crea una segunda conexión Codex ni requiere que el plugin reciba o lea las credenciales de Codex. Las lecturas de otros plugins siguen pasando por `/v1/plugin-api/mcp/tools/invoke-read`, sujetas a la lista permitida y al alcance del usuario.

Se usan dos PR separados para no alterar el núcleo ni Pulse hasta validar: [#118, Core](https://github.com/diegocesaretti/SOL/pull/118), y [#117, SOL Agent](https://github.com/diegocesaretti/SOL/pull/117). **El PR #117 requiere el puente de #118 antes de cualquier instalación del plugin**, pues declara el requisito de host `ai.reason`.

## Seguridad y presupuesto

- El Core acepta exclusivamente un token runtime de plugin emitido por SOL, con permiso aprobado `ai.reason`, `pluginId=sol-agent`, y miembro **activo owner/adult** (según la base de SOL).
- El mensaje a Codex utiliza instrucciones fijas del Core; el contenido de observaciones, memoria y herramientas se trata como datos no confiables. El plugin solo aporta un objeto `context` de hasta 18 KB.
- El Core invoca **Codex**, nunca el modo `auto` que podría cambiar silenciosamente a OpenAI API.
- Se limitan las llamadas a 6 por hora y 30 por día por miembro/plugin en la memoria del proceso Core. SOL Agent también reserva su cuota duradera por día. Los contadores del Core son defensivos **pero se reinician con el proceso**; para producción haría falta una cuota persistida o centralizada.
- `ai.reason` no autoriza `mcp.invoke.actions`, ni otorga control de Home Assistant, BWA 3D, Bambuddy, pagos, archivos o mensajes.
- SOL Agent valida el JSON de decisión, herramientas autorizadas, evidencia y reglas de hogar/negocio antes de registrar una propuesta. No ejecuta ninguna propuesta.
- La conexión con Codex **sí transmite el contexto de la misión al servicio asociado a la cuenta ChatGPT conectada**. Esto debe considerarse al escoger fuentes y aprobar el permiso; el modelo local sigue siendo opción para datos que deban permanecer totalmente en el equipo.
- El contrato no implica disponibilidad ilimitada de Codex. Si la cuenta está desconectada o se alcanzan límites, la misión falla con reintento/backoff, sin ejecutar acciones.

## Configuración de prueba (NO producción)

1. Revisar y probar PR #118; su integración debe validarse antes de cargar el plugin.
2. Instalar una compilación experimental de #117 exclusivamente en un entorno de prueba.
3. Aprobar `ai.reason`, `mcp.invoke.read` y `mcp.register` solo para una instalación con alcance de miembro correcto.
4. `SOL_AGENT_ENGINE=codex` (valor por defecto); `SOL_AGENT_AUTONOMY_ENABLED=true` únicamente al iniciar pruebas supervisadas.
5. Configurar una misión y **solo** las herramientas MCP de lectura necesarias en `SOL_AGENT_TOOLS_JSON`.
6. Verificar con una misión de datos sintéticos que la respuesta Codex es JSON estructurado, los permisos ajenos se rechazan y los presupuestos de uso funcionan.
7. Evaluar uso, latencia, propuestas incorrectas, privacy review y reinicio antes de habilitar observación continua.

`autoStart=false` y `SOL_AGENT_AUTONOMY_ENABLED=false` se mantienen por defecto. Las versiones actuales no están desplegadas en el HTPC.

## Estado real

**Implementado y con pruebas unitarias:** el Core ofrece el endpoint Codex acotado, el plugin lo consume mediante el token de runtime y el motor del agente conserva la planificación persistente. La prueba extremo a extremo con una cuenta Codex real, el gestor de SOL, y datos reales de Panorama/Life aún está pendiente. Pi sigue disponible como motor de razonamiento opcional con sus propios proveedores, pero **la ruta predeterminada de Codex NO pasa por Pi**; no debe confundirse con sesiones Pi que utilicen directamente OAuth de Codex.
