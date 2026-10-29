# SOL Agent — experimental 0.3.1 (autonomous shadow mode)

**This is a development-only plugin.** It does not replace Pulse, run device actions, change listings, control printers, or send Nexo/WhatsApp messages. Default: `autoStart=false`, no sources configured, local-model inference disabled.

## Autonomía experimental v0.2

Se añadió un motor de misiones duraderas con calendario, historial resumido, reanudación tras reinicios y decisiones del modelo entre consultar una herramienta MCP, concluir o esperar. El modelo solamente puede seleccionar herramientas de lectura expresamente habilitadas por SOL y sus argumentos están predefinidos por el propietario.

Se configura con `SOL_AGENT_AUTONOMY_ENABLED`, `SOL_AGENT_TOOLS_JSON` y `SOL_AGENT_GOALS_JSON`. El razonamiento necesita un modelo local activado expresamente. Los nuevos MCP son `sol_agent_missions`, `sol_agent_goal_create`, `sol_agent_goal_pause` y `sol_agent_feedback`.

El registro duradero se guarda en `SOL_PLUGIN_DATA_DIR/sol-agent-missions.json`. Los datos completos recibidos de las herramientas solo se utilizan temporalmente en memoria; al disco van resúmenes, identificadores y hashes.

**No está instalado ni activado en producción.** Es un prototipo con límites, sin ejecución de acciones externas, sin navegador, sin delegación entre agentes y con adaptador SDK Pi experimental desactivado por defecto; no se integró el código fuente de Rakazo. No se ha verificado su compatibilidad con todos los plugins.

## Aprendizajes aplicados de Home Assistant y negocios

Las misiones pueden elegir perfil `home`, `business` o `general`. El perfil hogar exige dos lecturas coincidentes del mismo origen en ciclos separados por al menos dos minutos antes de registrar una sugerencia; se evitan alertas por una medición aislada. El perfil negocio exige evidencia de herramientas consultadas, favorece revisar producción, pedidos y stock, y nunca modifica registros.

El plugin tiene un catálogo diagnóstico para cinco dominios existentes (Home Assistant, Bambuddy, BWA 3D, Finanzas y Educación). Es una lista orientativa, **no una concesión de acceso**: cada lectura sigue pasando por `/v1/plugin-api/mcp/tools/invoke-read` y los permisos originales de SOL. Nombres de herramientas con verbos de acción o escritura son rechazados al cargar el catálogo. Plugins futuros pueden aportar lecturas adicionales autorizadas.

Se añadió `sol_agent_goal_wake` (scope `submit`) para adelantar un objetivo cuando llegue un evento externo autorizado. Requiere un objetivo existente, respeta pausas y deduplica despertares durante cinco minutos. **No está conectado automáticamente a Pulse ni a otros publicadores**, no contiene payloads de eventos y no ejecuta acciones.

Ver [escenarios y pruebas de aceptación](USE_CASES.md). Ni los perfiles ni los ejemplos están activados automáticamente.

## Motor Pi opcional (v0.3)

Existe un adaptador para el SDK real de Pi, con sesiones efímeras en memoria y **todas las herramientas internas desactivadas**. Las decisiones se ejecutan únicamente mediante la lista de lecturas de SOL y su comprobación de permisos. Su activación requiere opt-in explícito para el envío de datos a un proveedor remoto y credenciales del modelo; no hay credenciales guardadas en el código. Pi se empaqueta en artefactos de CI con dependencias bloqueadas; aún no se ha probado su instalación mediante el gestor del HTPC.

[Detalles técnicos, privacidad y limitaciones de empaquetado](PI_INTEGRATION.md).

## Purpose
SOL Agent is a deliberately small compatibility bridge for future agentic reasoning, inspired by the architectural patterns of Rakazo. It **does not copy or vendor Rakazo source code**. An optional Pi SDK reasoning adapter has been added but is not bundled in the .solplugin distribution; see [PI_INTEGRATION.md](PI_INTEGRATION.md).

It uses SOL's existing plugin lifecycle and owner-scoped `/v1/plugin-api/mcp/tools/invoke-read` endpoint; tool arguments are explicitly configured rather than guessed. That permits data sources from any existing plugin **only when SOL authorizes that read tool**. This is not yet proof of end-to-end compatibility with every plugin.

## Configuring sources (manual, least-privilege)
`SOL_AGENT_SOURCES_JSON` is a JSON array with up to 16 entries:
```json
[
  {"id":"home-kitchen","name":"home_assistant_get_state","arguments":{"entityId":"climate.aire_cocina"}},
  {"id":"finance-due","name":"finanzas_vencimientos_list","arguments":{"limit":20}}
]
```
These are examples, not automatic installation settings. Do not include passwords, camera feeds, location histories or sensitive data. Read access is subject to SOL's owner permissions and its read-tool gate.

## Intelligence and privacy
Requires a local OpenAI-compatible model endpoint (e.g. a locally served model at `http://127.0.0.1:11434/v1/chat/completions`). To use it, explicitly configure `SOL_AGENT_MODEL_ENABLED=true` and `SOL_AGENT_MODEL_NAME`. The plugin rejects remote model endpoints; it never sends personal tool data to cloud AI.

On the first observation it establishes a baseline. Later changes can produce up to five reasoned proposals per cycle (max eight model analyses per day). Findings are kept under SOL's plugin-data directory; only proposal summaries, hashes and source IDs are stored, not raw tool snapshots. Errors do not produce phantom proposals and do not advance failed checkpoints.

## Read-only tools
- `sol_agent_status`: health, counts and model configuration, no personal data.
- `sol_agent_proposals`: proposal summaries for review; no external action.
No write, approve, execute or send tool is registered. Local `GET /health` binds to 127.0.0.1 only.

## Tests
```sh
node --test plugins/sol-agent/*.test.mjs
node scripts/pack-sol-plugin.mjs plugins/sol-agent dist/SOLAgent-0.1.0.solplugin
```

## Production safeguards
Only a dedicated development branch. Before any install: test the package against the latest SOL host; inspect the API read permissions, privacy scopes and failure modes; run side by side with Pulse; measure false positives and resource consumption. Never deploy to the HTPC, update `SOL-Full`, or merge to `main` without an explicit review.
