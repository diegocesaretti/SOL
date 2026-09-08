# Home Assistant · SOL plugin

Native SOL plugin for Home Assistant. It keeps an event-driven local mirror of Home Assistant state so Codex can read current state without polling Home Assistant on every turn.

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

## MCP tools

- `home_assistant_cache_status`
- `home_assistant_get_state`
- `home_assistant_search_states`
- `home_assistant_list_people`
- `home_assistant_list_areas`
- `home_assistant_get_services`
- `home_assistant_call_service`

The last tool requires an MCP token with action/submit scope, plugin `allow_control=true`, and `confirmedByUser=true`.
