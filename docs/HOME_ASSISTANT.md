# Home Assistant connector

Home Assistant is a first-class SOL **source**. The current connector is deliberately read-only; action/control support is reserved for a later phase with explicit per-entity permissions and stronger action policy.

## Architecture

```text
Home Assistant
  ├── REST /api/states      discovery + current-state reconciliation
  └── WebSocket state_changed
               │
               ▼
      selected entities only
               │
        ┌──────┴──────┐
        ▼             ▼
 current state     meaningful changes
 mirror            → source_items
        │             │
        └──────┬──────┘
               ▼
              SOL
        Life / Timeline
```

## Authentication

The current local-household profile uses a Home Assistant **Long-Lived Access Token** created by an administrator in Home Assistant.

SOL stores:

```text
PostgreSQL / Neon
├── Home Assistant base URL
└── AES-256-GCM encrypted token

SOL host only
└── .sol/secrets/home-assistant.key
```

The plaintext token is never returned by SOL APIs and is not stored in `source_accounts`.

## Setup

Open:

```text
http://127.0.0.1:3000/home-assistant
```

An `owner` or `adult` enters:

- a label, such as `Casa`;
- the Home Assistant URL, commonly `http://homeassistant.local:8123` or a private HTTPS URL;
- a Long-Lived Access Token.

SOL verifies the REST API before persisting the account, discovers entities through `/api/states`, and starts the Home Assistant WebSocket stream.

## Explicit entity selection

SOL intentionally does **not** ingest every Home Assistant entity.

An administrator selects the entities that should be visible to SOL. This prevents large installations and high-frequency sensors from generating unnecessary PostgreSQL/Neon writes.

Each selected entity has a record mode:

### `changes`

Keep the current state and create a Life/source item when the actual state string changes.

Good examples:

- `binary_sensor.*`
- `person.*`
- `device_tracker.*`
- `alarm_control_panel.*`
- selected `climate.*`
- selected doors/covers/locks/lights when their transitions matter to SOL.

### `snapshot`

Keep only the latest current state. Do not create a timeline item for every state update.

This is the default for `sensor.*`, because values such as temperature, power or energy may update frequently. Current sensor state remains available in the connector UI and can later feed authorized contextual reasoning/briefs without storing every measurement as a Life event.

## Realtime stream

SOL follows Home Assistant's WebSocket authentication sequence and subscribes specifically to `state_changed`.

Only events whose `entity_id` is in SOL's in-memory selected-entity map continue into persistence. Events from unselected entities are discarded before a PostgreSQL query.

The connector reconnects with exponential backoff. Authentication/subscription errors mark the source account as errored rather than granting fallback behavior.

## Restart reconciliation

WebSocket event streams are not historical queues. If SOL was offline, it must not invent the state transitions it missed.

On SOL startup/restart:

1. fetch Home Assistant current states;
2. keep only explicitly selected entities;
3. update their latest-state mirror;
4. do **not** create timeline events for the unknown gap;
5. resume live `state_changed` streaming.

This means SOL may know the correct current state after downtime without pretending to know exactly when missed transitions happened.

## Life data

For a selected entity in `changes` mode, a real state transition creates a standard `source_item`:

```text
provider        home_assistant
kind            home_assistant_state
visibility      family
owner           none / household
body            old_state → new_state
metadata        entity/domain/name/device-class/unit
```

That immediately makes the event available to the privacy-filtered `/life` timeline and future Knowledge consolidation.

## Read vs control permission

The schema already separates:

```text
selected_for_sync       read/source permission
selected_for_control    future control capability
home_assistant_control_grants
```

`selected_for_control` defaults to `false` and the current server exposes **no route that calls Home Assistant services**.

A later control phase should validate:

- authenticated SOL member;
- entity/service grant;
- risk level;
- proposal/approval policy where needed;
- audit through `action_log`;
- then and only then call the Home Assistant service API.

## Current test boundary

Pure URL/WebSocket URL normalization tests are included. A real integration test still needs to run on the target SOL host and should cover:

1. REST token authentication;
2. entity discovery;
3. selecting one binary entity and one numeric sensor;
4. live WebSocket subscription;
5. binary change → `/life` timeline item;
6. numeric sensor in snapshot mode → current state only;
7. SOL restart → selected-state reconciliation;
8. WebSocket reconnect.
