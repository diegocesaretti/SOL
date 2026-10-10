# Panorama contextual — MVP (feature branch)

## Alcance

Pantalla accesible en `/panorama`. No reemplaza el onboarding ni el dashboard histórico de `/` en esta fase. Se agrega una entrada de navegación y un acceso desde el dashboard post-login.

La UI consulta, **solo mediante GET y con la sesión actual**, estas rutas del núcleo SOL:

| Vista | Fuente existente |
|---|---|
| Sesión | `/v1/auth/me` |
| Cuentas/fuentes | `/v1/inputs` |
| Plugins y salud | `/v1/inputs/plugins` |
| Observaciones recientes | `/v1/life/timeline?limit=80` |
| Entidades de personas | `/v1/knowledge/entities?kind=person` |
| Entidades de proyectos | `/v1/knowledge/entities?kind=project` |

La autorización y el filtrado por miembro/visibilidad dependen de los endpoints del backend existentes. **No se crea un índice agregado que mezcle información privada entre usuarios.** El HTML inicial no lleva datos de miembros embebidos. No se agregan credenciales, automatizaciones ni escrituras. Las llamadas están sujetas a un timeout de 12 segundos y se refrescan cada 60 segundos únicamente con la página visible.

## Clasificación y explicabilidad

- **Observado:** actividad devuelta por Life, con fecha, proveedor, fuente y enlace para inspección.
- **Señal:** entrada con `intelligencePriority === 'high'` o plugin/fuente con estado explícito de error/degradación. No se describe como una acción que SOL haya tomado.
- **Anticipado:** exclusivamente tareas con `metadata.dueAt` o `metadata.dueDate` en formato de fecha válido y dentro de 72 horas; se muestra como vencimiento estructurado, no como pronóstico aprendido.
- **Sin evidencia:** usar un estado vacío. Nunca rellenar con pronósticos imaginarios.

Los indicadores de actividad describen la **cantidad de elementos en la ventana consultada (máximo 80)**, no una métrica histórica exhaustiva. Los filtros Hogar / Producción / Familia son heurísticas explícitas por **proveedor**, no una clasificación semántica del contenido de una conversación.

## Próximos pasos para hacerla predictiva de verdad

1. Endpoint backend `/v1/insights` con eventos normalizados, `sourceRefs`, tipo, propietario, visibilidad, horizonte, cálculo `computedAt`, versión de regla y caducidad.
2. Motor determinista de reglas con pruebas: estado desconectado persistente, fechas de vencimiento, impresoras desocupadas, stock de productos y alertas educativas.
3. Históricos agregados por fuente y métricas confiables de cobertura. No extrapolar de una página truncada de eventos.
4. Predicciones estadísticas (probabilidad, intervalo, error observado, datos usados), sólo cuando existan muestras suficientes.
5. Recomendaciones con `suggestedAction` enlazada a flujos de aprobación ya existentes; nunca ejecutar en el frontend automáticamente.
6. E2E en sesión de familia/owner/guest con fixtures sensibles, mobile y lectores de pantalla.

## Seguridad y limitaciones del MVP

- SOL sigue validando los permisos de cada GET en el backend.
- Las fechas derivadas de texto libre no se parsean.
- La pantalla no consulta directamente los plugins de Bambuddy, ML ni Home Assistant; muestra su actividad cuando ya está proyectada a las fuentes comunes. Las métricas específicas de impresión, ventas y clima son una expansión posterior.
- No se habilitan predicciones basadas en IA ni acciones automáticas.
- Para la integración ejecutar en un entorno de prueba `npm --workspace @sol/server run typecheck` y `npm --workspace @sol/server test`, y hacer prueba manual de permisos y vistas responsive.
