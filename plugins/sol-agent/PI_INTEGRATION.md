# SOL Agent 0.3 — Adaptador Pi experimental

**Estado:** código en PR borrador, no activado en HTPC, no incluido en SOL-Full.

## Qué agregamos

El adaptador `pi-adapter.mjs` utiliza la biblioteca real `@earendil-works/pi-coding-agent` y su SDK `createAgentSession`. Pi se ejecuta **sin ninguna herramienta habilitada** (`noTools: "all"`, `tools: []`, `customTools: []`) y con un cargador vacío de extensiones, skills y prompts externos. Su sesión es `SessionManager.inMemory()`: no guarda un archivo de transcripción Pi con datos crudos. Las misiones, fechas, hashes, feedback y propuestas siguen persistiendo en el archivo de SOL Agent.

El modelo decide un paso JSON (`read`, `wait` o `finish`). **No tiene acceso directo a dispositivos, navegación, terminal, archivos ni API MCP.** Solo el bucle de SOL Agent puede realizar lecturas a través del endpoint existente `/v1/plugin-api/mcp/tools/invoke-read`, con lista autorizada, argumentos fijos, límites diarios y permisos de SOL.

## Opt-in de privacidad

Por defecto `SOL_AGENT_ENGINE=local`, `SOL_AGENT_AUTONOMY_ENABLED=false`, `SOL_AGENT_MODEL_ENABLED=false` y `autoStart=false`. Para experimentar con Pi se requiere elegir:

- `SOL_AGENT_ENGINE=pi`
- `SOL_AGENT_PI_PROVIDER`: `anthropic`, `openai` o `google`
- `SOL_AGENT_PI_MODEL_ID`: identificador explícito compatible con Pi
- `SOL_AGENT_PI_API_KEY`: secreto administrado por el gestor de SOL, nunca escrito en Git
- `SOL_AGENT_PI_ALLOW_REMOTE=true`: autorización expresa de que **los resúmenes, observaciones, objetivo y feedback de la misión se enviarán al proveedor elegido**.
- `SOL_AGENT_AUTONOMY_ENABLED=true` y catálogo MCP de lecturas autorizado.

Si falta cualquier requisito, Pi no arranca. La rama experimental no tiene configuración activada ni credenciales reales.

## Dependencia y empaquetado

Se verificó la API publicada del SDK Pi v1.4.0, desde el proyecto Pi (licencia MIT). Actualmente la dependencia **NO está incorporada al archivo .solplugin ni a la distribución Windows**. Al seleccionar el motor Pi sin tener la biblioteca disponible en el entorno de desarrollo, la misión produce error controlado y reintenta con demora. El workflow `sol-agent-shadow.yml` instala Pi en un **directorio temporal aislado** para verificar los exports reales del paquete; los tests normales utilizan un SDK simulado para comprobar las barreras de seguridad.

Antes de probarlo en un HTPC hace falta definir el empaquetado reproducible de dependencias (incluyendo lockfile, auditoría y rollback), ejecutar un modelo real en sandbox, y medir fallos, latencia y consumo. No instalar Pi dentro de la ruta de producción ni hacer `npm install` en el plugin que se va a empaquetar con el empaquetador recursivo existente.

## Diferencias respecto a Rakazo

Rakazo combina Pi, trabajadores persistentes, computadoras aisladas, herramientas y delegación. Nuestra versión integra **el SDK Pi solo como motor de razonamiento opcional**. La persistencia es propia de SOL; la delegación, navegación y herramientas nativas de Pi siguen deshabilitadas. No se ha copiado código de Rakazo. No es todavía un producto comparable a Rakazo o Dots, pero establece una frontera segura para integrar progresivamente agentes reales.

Referencias:
- https://github.com/elie222/rakazo/blob/main/docs/computer-runtime.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md
- https://www.npmjs.com/package/@earendil-works/pi-coding-agent
