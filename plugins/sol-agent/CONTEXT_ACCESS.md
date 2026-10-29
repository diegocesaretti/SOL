# Integración de contexto SOL: Panorama y Life (auditoría de contratos)

Revisión de lectura del Core SOL `main` (octubre 2026), **sin modificar Core ni instalar el agente**.

## Endpoints presentes

- `apps/server/src/modules/panorama/routes.ts`: `GET /v1/panorama/digest/day?date=YYYY-MM-DD` y `GET /v1/panorama/digest/calendar?month=YYYY-MM`. Requieren el principal autenticado de SOL. El endpoint de generación usa POST y modifica estado; no sirve para la lectura de un agente experimental.
- `apps/server/src/modules/life/routes.ts`: `GET /v1/life/timeline?limit=N&before=...`, consultado bajo un principal SOL.
- `apps/server/src/modules/mcp/data.ts`: las funciones internas `getMcpTimeline(principal,...)` y `searchMcpLife(principal,...)` usan la visibilidad del miembro. Los datos privados **no son legibles por todos los integrantes del hogar**, ni siquiera para un propietario sin permisos individuales.

## Brecha de autorización

El plugin SOL Agent recibe `SOL_PLUGIN_TOKEN` y accede únicamente a `POST /v1/plugin-api/mcp/tools/invoke-read`, que invoca herramientas *registradas por plugins* tras una verificación de permisos.

Los endpoints directos de Panorama y Life usan `AuthPrincipal` de SOL y **no está comprobado que admitan el token runtime de plugin**. No debe hacerse una llamada GET directa con `SOL_PLUGIN_TOKEN`, reutilizar una cookie de navegador ni acceder directamente a PostgreSQL.

## Próxima integración segura

Agregar al Core, en un PR SEPARADO y revisado, una interfaz de contexto `/v1/plugin-api/context/read` exclusivamente de lectura, con:
1. Resolución del miembro propietario mediante las credenciales propias del plugin (sin privilegios implícitos).
2. Límites de visibilidad por miembro/proyecto y minimización de información: límite de eventos, tamaño y sensibilidad.
3. Categorización de solicitudes de Panorama y Life (no exponer toda la base).
4. Auditoría de cada consulta y errores de permisos explícitos.
5. Pruebas de no filtración cruzada entre integrantes ni elevación por instrucciones del modelo.

Mientras eso no esté implementado, SOL Agent NO consumirá automáticamente la memoria Life ni el digest de Panorama. Puede consultar herramientas MCP de otros plugins únicamente bajo el allowlist y permisos que ya existen.

Referencias de código:
- https://github.com/diegocesaretti/SOL/blob/main/apps/server/src/modules/panorama/routes.ts
- https://github.com/diegocesaretti/SOL/blob/main/apps/server/src/modules/life/routes.ts
- https://github.com/diegocesaretti/SOL/blob/main/apps/server/src/modules/mcp/data.ts
