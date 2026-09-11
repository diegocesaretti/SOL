# Home Assistant · SOL plugin

Native SOL plugin for Home Assistant. It keeps an event-driven local mirror of Home Assistant state, adds optional computer-use control for Android TV, and from **0.3.5** adds a Stremio deep-link layer compatible with the **standard Stremio Android TV app from Google Play**.

## Stremio 0.3.5

Stremio itself is not modified, repackaged or replaced. SOL launches documented `stremio://` deep links through Home Assistant's Android TV Remote integration:

```text
SOL / Codex
   → HomeAssistant.solplugin
      → remote.turn_on(activity="stremio:///...")
         → standard Stremio app
```

Pause/play/volume/seek remain Home Assistant media/remote actions. The Stremio layer is responsible for semantic content navigation.

### Stremio MCP tools

- `home_assistant_stremio_status`
- `home_assistant_stremio_search`
- `home_assistant_stremio_resolve`
- `home_assistant_stremio_open_page`
- `home_assistant_stremio_open_search`
- `home_assistant_stremio_open_detail`
- `home_assistant_stremio_play`
- `home_assistant_stremio_adjacent_episode`
- `home_assistant_stremio_open_catalog`
- `home_assistant_stremio_open_addon`
- `home_assistant_stremio_open_deep_link`

`search`, `resolve` and `play` use Cinemeta to turn natural titles into Stremio/IMDb ids. Series requests can resolve an exact season and episode and construct the corresponding `videoId`. `adjacent_episode` can resolve the next or previous Cinemeta episode.

Examples:

```text
"Abrí Stremio"
→ stremio:///board

"Buscá Interstellar"
→ stremio:///search?search=Interstellar

"Poné Breaking Bad temporada 2 episodio 3"
→ resolve title → tt0903747
→ videoId tt0903747:2:3
→ stremio:///detail/series/tt0903747/tt0903747:2:3?autoPlay=true
```

### Official deep-link limitation

`autoPlay=true` is best-effort on Android TV. Official Stremio deep links cannot force a specific stream, addon/provider, quality or audio source. If Stremio does not already know a usable stream URL or `bingeGroup`, it may stop at the detail/stream-selection screen. The Android TV Satellite can then be used for visual fallback/verification without modifying Stremio.

## Existing Home Assistant tools

State/control:

- `home_assistant_cache_status`
- `home_assistant_get_state`
- `home_assistant_search_states`
- `home_assistant_list_people`
- `home_assistant_list_areas`
- `home_assistant_get_services`
- `home_assistant_call_service`

Optional Android TV Satellite:

- `home_assistant_tv_status`
- `home_assistant_tv_observe`
- `home_assistant_tv_screenshot`
- `home_assistant_tv_tap`
- `home_assistant_tv_click_text`
- `home_assistant_tv_set_text`
- `home_assistant_tv_launch_app`
- `home_assistant_tv_navigate`
- `home_assistant_tv_navigate_path`

## Stremio setup

1. Install the normal Stremio Android TV app from Google Play.
2. In Home Assistant configure **Android TV Remote** for that TV.
3. Put its `remote.*` entity in **Remote Android TV para Stremio**. If left blank, the plugin reuses `tv_remote_entity_id`.
4. Enable **Permitir control desde Codex**.
5. Keep **Control Stremio por deep links** enabled.

No custom Stremio APK, pairing token or modified package name is required.
