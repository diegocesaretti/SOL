# SOL Agent — escenarios reales y criterios de aceptación (investigación, octubre 2026)

Este documento traduce experiencias de usuarios de Home Assistant y automatización de negocios en pruebas para SOL Agent. **No activa misiones ni conecta sistemas reales.** Los ejemplos son objetivos propuestos, no estados de la casa ni resultados de BWA 3D.

## Qué aprendimos

- La comunidad de Home Assistant valora especialmente cambios silenciosos, avisos basados en presencia/horario y notificaciones solo ante hechos relevantes: [anuncios selectivos por cámara](https://www.reddit.com/r/homeassistant/comments/1o4xa36/), [aviso de freezer abierto](https://www.reddit.com/r/homeassistant/comments/1vzd2z2/), [recomendaciones sobre ventilación](https://www.reddit.com/r/homeassistant/comments/1wggk3r/).
- Una lectura aislada puede ser ruido: [falsos positivos por sensor de humedad](https://www.reddit.com/r/homeautomation/comments/1ox70um/what_have_you_tried_to_automate_but_have/). Para el perfil `home` se exigen **dos lecturas coincidentes en ciclos diferentes**, separadas por dos minutos o más; no se infieren emergencias.
- La documentación oficial recomienda [exponer el mínimo de entidades](https://www.home-assistant.io/voice_control/best_practices/) y controlar especialmente los [scripts y acciones LLM](https://www.home-assistant.io/voice_control/exposing_scripts_to_llms/). SOL Agent solo tiene acceso a `mcp.invoke.read`.
- En pequeñas empresas funcionan los flujos de [revisión de stock con aprobación humana](https://www.reddit.com/r/n8n/comments/1odejel/) y los contratos de datos, reintentos e idempotencia importan más que un prompt deslumbrante: [experiencias de n8n](https://www.reddit.com/r/n8n/comments/1ssj50a/i_wasted_months_building_ai_agents_in_n8n_before/).

## Matriz de casos que queremos validar

| Dominio | Ejemplo de objetivo | Lecturas permitidas (solo si el propietario las habilita) | Conducta deseada | No hacer |
| --- | --- | --- | --- | --- |
| Hogar | Identificar problemas persistentes de clima/temperatura | `home_assistant_get_state` en entidades seleccionadas | Confirmar estabilidad de la observación, registrar sugerencia; agrupar novedades | Cambiar clima o enviar avisos nocturnos |
| Hogar | Detectar datos incompletos o dispositivos no disponibles | `home_assistant_cache_status`, `home_assistant_get_state` | Distinguir `unavailable` de un equipo apagado | Inventar estado de un dispositivo |
| BWA 3D + Bambuddy | Detectar riesgo de producción | `bwa_3d_status`, `bambuddy_queue`, `bambuddy_fleet_status` | Correlacionar la información disponible, verificar la fuente y proponer revisión | Imprimir, modificar stock o publicaciones |
| Bambuddy | Evaluar problemas repetidos en impresoras | `bambuddy_fleet_status`, `bambuddy_printer_status` | Analizar tendencia/historial verificable, sugerir inspección | Reiniciar impresoras |
| Finanzas | Preparar revisión de vencimientos próximos | `finanzas_vencimientos_list` | Mostrar vencimiento como pendiente de verificación según la fuente | Pagar o marcar pagado |
| Educación | Revisar tareas y fechas importantes | `educacion_tareas`, `educacion_proximas_evaluaciones` | Sugerir revisión del calendario familiar | Crear o cambiar eventos automáticamente |

Las lecturas anteriores están basadas en nombres de herramientas presentes en el repositorio SOL. El contrato `mcp.invoke.read` sigue aplicando los permisos efectivos del usuario y de cada plugin. Un nombre reconocido **no implica** que el agente esté autorizado a usarlo ni que el dato esté actualizado.

## Misiones de ejemplo (desactivadas)

Ejemplo de `SOL_AGENT_GOALS_JSON` para un entorno de prueba:

```json
[
  {
    "id": "home-comfort",
    "profile": "home",
    "objective": "Investigar anomalías persistentes de climatización y proponer mejoras de confort sin cambiar dispositivos.",
    "intervalMinutes": 60
  },
  {
    "id": "business-printers",
    "profile": "business",
    "objective": "Revisar disponibilidad de impresoras y cola de producción, priorizar problemas comprobables y proponer acciones sin ejecutarlas.",
    "intervalMinutes": 60
  }
]
```

Para activar una prueba se requiere: instalación manual en **un entorno aislado**, fuentes explícitas en `SOL_AGENT_TOOLS_JSON`, modelo local funcional, `SOL_AGENT_MODEL_ENABLED=true` y `SOL_AGENT_AUTONOMY_ENABLED=true`. Por defecto todo queda apagado, también `autoStart=false`.

## Criterios antes de evaluar despliegue

1. Cero invocaciones de herramientas de escritura o control; rechazar nombres peligrosos al configurar y volver a validar con SOL en cada lectura.
2. Sin propuestas domésticas por una lectura aislada; pruebas ante sensor intermitente, `unknown` y `unavailable`.
3. Información empresarial no enviada a terceros: para v0.2 el modelo está limitado a un endpoint local.
4. Cero propuestas duplicadas en 24 horas con mismo título y fuentes; respetar feedback explícito sobre propuestas repetitivas.
5. Si un plugin falla, el agente debe registrar el error y reintentar con demora; nunca declarar el servicio activo si no puede leer.
6. Probar continuidad de misión tras reinicio y comprobar que los datos crudos de las herramientas no queden persistidos en el historial.
7. Medir semanalmente propuestas útiles, irrelevantes e incorrectas, latencia, consultas al modelo y tiempo para detectar un problema real.
8. Validar los contratos con pruebas reales por plugin antes de considerar compatibilidad completa. Mantener Pulse, Panorama, Life y SOL-Full intactos.

## Todavía pendiente

No tenemos aquí motor Pi/Rakazo integrado ni navegador autónomo. Tampoco notificaciones Nexo, aislamiento fuerte para herramientas, memoria semántica de SOL Life, multiagentes o una evaluación de calidad con un modelo real. Ninguna de esas capacidades debe darse por implementada por la existencia de este documento.
