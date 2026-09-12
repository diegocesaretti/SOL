# Home Assistant · SOL plugin

Native SOL plugin for Home Assistant. It keeps an event-driven local mirror of Home Assistant state, adds optional computer-use control for Android TV, and includes Stremio integration compatible with the **standard Stremio Android TV app from Google Play**.

## Stremio 0.3.6

0.3.6 extends the 0.3.5 deep-link layer with native support for the Stremio addon protocol. SOL can now query user-configured addon manifests, request their `stream` resources, merge/deduplicate the results and rank them before opening Stremio.

```text
SOL / Codex
   → HomeAssistant.solplugin
      → Cinemeta title/episode resolution
      → configured Stremio addons
         → /stream/{type}/{videoId}.json
      → dedupe + ranking
      → selected stream
```

The standard Stremio app is never modified or repackaged.

### Stream ranking

The selector can infer and rank by:

- 4K / 1080p / 720p / 480p
- Latino / Español / English labels
- H.264 / H.265 / AV1
- file size when advertised in the stream label
- seeders when advertised
- cached/debrid hints when advertised
- HDR / Dolby Vision preferences
- preferred addon/provider
- low-quality CAM/TS/Screener penalties

Configured addon manifest URLs are stored as a plugin secret because some addon configurations embed user-specific data in the URL. MCP stream tools return safe summaries and do not expose direct stream URLs or manifest URLs.

### MCP tools added in 0.3.6

- `home_assistant_stremio_addons`
- `home_assistant_stremio_streams`
- `home_assistant_stremio_select_stream`
- `home_assistant_stremio_play_best`
- `home_assistant_stremio_proxy_status`
- `home_assistant_stremio_proxy_install`

Existing 0.3.5 tools remain available:

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

### Example

```text
"Poneme Breaking Bad temporada 2 capítulo 3 en 1080p latino"

Cinemeta
→ tt0903747:2:3

Configured addons
→ provider A: 4K HEVC English
→ provider A: 1080p H264 Latino
→ provider B: 1080p English

SOL ranking
→ 1080p H264 Latino
```

## Exact selected-stream delivery: SOL Stream Selector

Official Stremio deep links do not accept an arbitrary `stream=`/`infoHash=` parameter. 0.3.6 therefore includes an optional Stremio addon proxy called **SOL Stream Selector**.

When enabled, SOL creates temporary `sol:` metadata/video IDs. Stremio requests those IDs from SOL Stream Selector, which returns **only the stream SOL selected**.

```text
SOL selects stream
      ↓
sol:<session>:series:tt0903747:2:3
      ↓
Stremio → SOL Stream Selector /stream/...
      ↓
one selected stream
      ↓
playback
```

The proxy preserves the upstream stream object (`url`, `infoHash`/`fileIdx`, `ytId`, etc.) and supplies a stable `bingeGroup` when the provider did not supply one.

### HTTPS requirement

Stremio requires remote addon URLs to use trusted HTTPS; the documented HTTP exception is `127.0.0.1`, which on Android TV refers to the TV itself, not the computer running SOL. Therefore the selector binds locally on port `8770` by default, but exact mode must be exposed through a trusted HTTPS reverse proxy/tunnel before installing it in Stremio.

Configure:

- **SOL Stream Selector proxy** = enabled
- **Puerto local Stream Selector** = normally `8770`
- **Origen HTTPS público del selector** = e.g. `https://stremio-sol.example.com`
- **Token secreto Stream Selector** = stable random 12+ character token

Then invoke `home_assistant_stremio_proxy_install` once. Stremio opens its normal addon-install prompt. After installation, enable **Usar selector exacto al reproducir**.

If the HTTPS selector is not configured, `home_assistant_stremio_play_best` still resolves and ranks the best stream, opens the normal Stremio stream-selection page with autoplay disabled, and returns a precise addon/title/quality hint so Android TV Satellite can select the matching visible result.

## Existing Home Assistant + TV architecture

Pause/play/volume/seek remain Home Assistant media/remote actions. Android TV Satellite remains an optional visual fallback/verification layer; it is not required for addon aggregation or exact selector mode.

Home Assistant state/control tools:

- `home_assistant_cache_status`
- `home_assistant_get_state`
- `home_assistant_search_states`
- `home_assistant_list_people`
- `home_assistant_list_areas`
- `home_assistant_get_services`
- `home_assistant_call_service`

Optional Android TV Satellite tools:

- `home_assistant_tv_status`
- `home_assistant_tv_observe`
- `home_assistant_tv_screenshot`
- `home_assistant_tv_tap`
- `home_assistant_tv_click_text`
- `home_assistant_tv_set_text`
- `home_assistant_tv_launch_app`
- `home_assistant_tv_navigate`
- `home_assistant_tv_navigate_path`
