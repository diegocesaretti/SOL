# SOL architecture

## Architectural style

SOL starts as a **modular monolith**. There is one deployable core process and one primary PostgreSQL database, but boundaries between modules are explicit. This is intentional: operational simplicity now, extraction paths later.

## End-to-end flow

```text
External sources
  WhatsApp / Google / Calendar / Home Assistant / files / voice / ...
            │
            ▼
       CONNECTORS
            │  normalized provider-neutral items
            ▼
        INGESTION
            │
            ├──────────────► immutable/source-backed LIFE records
            │
            ▼
       KNOWLEDGE
  entities / facts / relations / projects / commitments
            │
            ▼
         SOL CORE
 context / planner / permissions / conversation / automations
            │
            ├──────────────► AI PROVIDER (Codex first)
            │
            ▼
         ACTIONS
 Calendar / messages / e-mail / HA / tasks / notifications
```

## Household is the top-level boundary

No domain object should implicitly mean "the current user". Every source, record and derived object is associated with a `household_id`. Personal information may additionally have `owner_member_id` and a visibility policy.

A member can own zero, one or many source accounts. A source account can also be owned by the household (for example a shared family calendar).

```text
Household
├── Member A
│   ├── WhatsApp personal
│   ├── WhatsApp work
│   └── Google account
├── Member B
│   ├── WhatsApp personal
│   └── Google account
└── Shared
    └── Family calendar
```

The rest of SOL consumes normalized events and does not care how many WhatsApp sessions exist.

## Event-driven internally, not distributed by default

Modules communicate through domain events such as:

- `source.item.received`
- `message.received`
- `calendar.changed`
- `fact.created`
- `commitment.detected`
- `task.created`
- `action.requested`
- `action.completed`

The initial `InMemoryEventBus` is deliberately tiny. A durable outbox/Redis-backed dispatcher can replace it without changing event contracts.

## AI is a tool, not the database

SOL's state lives in PostgreSQL and source-backed storage. AI providers receive the minimum authorized context required for a task. The domain only depends on `AiProvider`, not on Codex-specific SDK types.

Expected initial adapter:

```text
AiProvider
  └── CodexProvider
        └── Codex App Server / SDK
              └── ChatGPT OAuth managed by Codex
```

A local or API-backed provider can be added later.

## Realtime + reconciliation

Connectors should prefer realtime/webhook/event feeds when available, while periodic reconciliation jobs repair missed events and discover changes. A daily consolidation job will derive higher-level facts, unresolved commitments and a next-day brief from the day's already-ingested data.

## Non-goals for the foundation

- No autonomous swarm of per-source agents.
- No direct LLM access to unrestricted SQL.
- No assumption that all household members can read each other's private sources.
- No credentials committed to Git.
- No premature microservices/Kubernetes/Kafka.
