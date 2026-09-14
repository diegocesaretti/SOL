# Home Assistant · SOL plugin

Plugin nativo de SOL para Home Assistant, Android TV y Stremio. La arquitectura actual usa **Home Assistant como único transporte de control de TV** y la **app oficial de Stremio para Android TV**, sin APK modificada, sin Android TV Satellite, sin Accessibility, sin screenshots y sin proxy selector externo.

## Arquitectura actual · 0.3.32

```text
SOL / Codex
   ↓
HomeAssistant.solplugin
   ├─ Home Assistant WebSocket + REST
   ├─ remote.send_command para Android TV
   ├─ Cinemeta para resolver títulos/episodios
   ├─ cuenta de Stremio y addons instalados
   └─ Stremio oficial
        ↓
      lista nativa horizontal de streams
        ↓
      LEFT/RIGHT × delta + DPAD_CENTER
```

El plugin mantiene un espejo local event-driven del estado de Home Assistant y expone herramientas para lectura/control. Para Stremio puede resolver películas y episodios, consultar addons, puntuar streams y, cuando se pide Español/Latino, reconstruir el orden nativo de la cuenta para navegar a la posición absoluta correspondiente.

## Selección Español / Latino por índice nativo

Para una orden como:

```text
"Poné Minions en latino"
```

la ruta recomendada es:

```text
resolver título / episodio
   ↓
consultar todos los addons de stream de la cuenta
   ↓
conservar orden de addons + orden de streams de cada addon
   ↓
filtrar Español / Latino / LATAM
   ↓
rankear calidad manteniendo nativeIndex
   ↓
abrir el detalle en Stremio oficial
   ↓
espera configurable
   ↓
LEFT/RIGHT desde el foco inicial hasta nativeIndex
   ↓
pausa configurable
   ↓
DPAD_CENTER
```

La selección es **fail-closed**: si no existe un stream del idioma pedido o el índice nativo no es confiable, SOL no confirma otro stream a ciegas.

Los parámetros relevantes son:

- `HA_SOL_STREMIO_OPEN_TO_KEYS_DELAY_MS`: espera después de abrir Stremio y antes del primer movimiento. Rango 0–60000 ms.
- `HA_SOL_STREMIO_INDEXED_KEY_DELAY_MS`: pausa entre movimientos LEFT/RIGHT.
- `HA_SOL_STREMIO_INDEXED_INITIAL_FOCUS_INDEX`: índice que Stremio deja enfocado al abrir la lista; actualmente 1 por defecto.
- `HA_SOL_STREMIO_INDEXED_CENTER_DELAY_MS`: pausa después del último movimiento y antes de `DPAD_CENTER`.

El diagnóstico registra el índice objetivo, foco inicial, movimientos realmente enviados, RIGHT suprimidos por compensación, LEFT inyectados, delays y si `DPAD_CENTER` fue enviado.

## Ranking de streams

Cuando corresponde seleccionar o resumir candidatos, SOL puede considerar:

- 4K / 1080p / 720p / 480p
- Latino / Español / English
- H.264 / H.265 / AV1
- tamaño del archivo cuando está informado
- seeders cuando están informados
- hints cached/debrid
- HDR / Dolby Vision
- proveedor/addon preferido
- penalizaciones para CAM/TS/Screener

Las URLs de manifests configurados se tratan como secretos porque algunos addons incluyen datos personales en su URL. Las herramientas MCP devuelven resúmenes seguros y no exponen URLs directas de streams ni manifests secretos.

## Cuenta de Stremio

La cuenta es opcional para la reproducción básica, pero habilita:

- biblioteca y Continue Watching
- progreso y episodios vistos
- addons instalados y su orden
- selección account-wide Español/Latino por índice nativo
- decisiones de siguiente episodio

El método recomendado es `authKey`; también existe login por email/contraseña. Los secretos quedan dentro del proceso del plugin.

Kids/Family usa la misma ruta account-wide de idioma cuando hay cuenta vinculada. Se conserva un manifest Family manual únicamente como fallback opcional.

## Herramientas Stremio

El plugin expone:

- `home_assistant_stremio_status`
- `home_assistant_stremio_search`
- `home_assistant_stremio_resolve`
- `home_assistant_stremio_addons`
- `home_assistant_stremio_streams`
- `home_assistant_stremio_select_stream`
- `home_assistant_stremio_play_best`
- `home_assistant_stremio_play`
- `home_assistant_stremio_adjacent_episode`
- `home_assistant_stremio_open_page`
- `home_assistant_stremio_open_search`
- `home_assistant_stremio_open_detail`
- `home_assistant_stremio_open_catalog`
- `home_assistant_stremio_open_addon`
- `home_assistant_stremio_open_deep_link`

`home_assistant_stremio_play` se conserva como alias compatible de la reproducción actual; no mantiene una segunda implementación de playback.

## Android TV: sólo Home Assistant

El control de TV utiliza exclusivamente la entidad `remote.*` configurada en Home Assistant. Las herramientas disponibles son:

- `home_assistant_tv_status`
- `home_assistant_tv_navigate`
- `home_assistant_tv_navigate_path`

No se usan capturas, coordenadas, Accessibility, `click_text`, `set_text` ni un servicio auxiliar en Android TV.

Antes de abrir un detalle de Stremio, el launch guard puede enviar la tecla de wake `0` por `remote.send_command`. No existe watchdog visual; la navegación posterior es determinista y auditable por comandos.

## Home Assistant

El plugin mantiene las herramientas normales de estado y servicios, entre ellas:

- `home_assistant_cache_status`
- `home_assistant_get_state`
- `home_assistant_search_states`
- `home_assistant_list_people`
- `home_assistant_list_areas`
- `home_assistant_get_services`
- `home_assistant_call_service`

Las actualizaciones WebSocket mantienen el caché al día y una reconciliación periódica corrige eventuales desvíos.

## Principios de la ruta Stremio

- Stremio es siempre la app oficial.
- Home Assistant es el único transporte de teclas.
- El ranking y la posición visual son conceptos separados: se puede elegir el mejor candidato sin perder su `nativeIndex`.
- No se colapsan entradas visuales si hacerlo pudiera cambiar la posición absoluta.
- Si un error previo vuelve inseguro el índice, no se manda CENTER.
- La reproducción genérica conserva un flujo simple configurable; la ruta account-wide Español/Latino usa navegación indexada explícita.
