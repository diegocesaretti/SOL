# Home Assistant · SOL plugin

Native SOL plugin for Home Assistant. It keeps an event-driven local mirror of Home Assistant state so Codex can read current state without polling Home Assistant on every turn. Version 0.3 also adds an optional visual-control bridge for **Codex TV Satellite** on Android TV 7.0+.

## Design

- Authenticated Home Assistant WebSocket connection.
- `state_changed` subscription is established before the initial `get_states` snapshot; events are buffered and replayed to close the snapshot/subscription race.
- States, entity registry, device registry, area registry and services are cached in memory and persisted atomically under `SOL_PLUGIN_DATA_DIR`.
- Child devices introduced in Home Assistant 2026.9 inherit area context through `parent_device_id`.
- `person.*` entities can be materialized as canonical SOL **Person** identities. A Person represents the human; it is not a SOL login/account and does not grant permissions.
- `safe-link` links the external HA identity to an existing SOL member only when the display name matches exactly and uniquely. It never creates a SOL member, changes a role or grants access.
- `external` keeps the HA person as a family-visible external Person without linking it to a SOL member.
- `home_assistant_list_people` reports both the HA state and the resolved canonical SOL Person id/link method so other SOL capabilities can refer to the same human consistently.
- Presence changes may be ingested into SOL Activity; arbitrary high-frequency sensor history is not ingested by default.
- MCP reads use the local cache. Service calls go to Home Assistant only when control is enabled and the current human explicitly confirmed the action.
- Android TV screenshots are requested on demand, not streamed continuously. `home_assistant_tv_observe` returns one current JPEG plus the Accessibility UI tree so Codex can use an action → observe → action loop.
- Android 7/8 can use Accessibility taps and text actions directly. DPAD/OK can automatically fall back to a configured Home Assistant `remote.*` entity when the Satellite reports that native DPAD is unavailable.

## MCP tools

Home Assistant state/control:

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

Action tools require an MCP token with action scope, plugin `allow_control=true`, and `confirmedByUser=true`.

## Android TV Satellite setup

Install the Codex TV Satellite APK on the television, enable its Accessibility service and authorize screen capture. The APK displays its local IP and token. In the Home Assistant plugin settings enable **Android TV Satellite** and configure:

- URL, for example `http://192.168.1.80:8765`
- Satellite token
- optional Home Assistant `remote.*` entity for DPAD fallback on Android 7/8

The Satellite API remains LAN-only and authenticated. SOL receives screenshots as MCP image content only when a TV observation/screenshot tool is called.
