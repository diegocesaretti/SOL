# SOL architecture

## Architectural style

SOL is a **family-first modular monolith**: one deployable core process and one primary PostgreSQL database, with explicit module boundaries. Operationally simple now, extractable later.

## End-to-end flow

```text
SOURCES
WhatsApp members / Google Calendar / future Gmail / Home Assistant / Mercado Libre / files / ...
                               │
                               ▼
                          CONNECTORS
                               │
                               ▼
                              LIFE
             source-backed timeline / messages / events
                               │
                               ▼
                           KNOWLEDGE
        entities / facts / relations / candidate extraction
                               │
                               ▼
                           EXECUTIVE
          proposals / tasks / planning / briefs / conflicts
                    │                       ▲
             approval policy                │
                    ▼                       │
                            ACTIONS          │
               Calendar / WhatsApp / HA / ML / ...
                                ▲            │
                                │            │
                           INTERFACES ────────┘
                    Web / SOL WhatsApp / Voice / ...
```

A provider may occupy more than one role. Google Calendar is both a source and an action target. Home Assistant and Mercado Libre are planned as source/action integrations. SOL's future dedicated WhatsApp account is primarily an **assistant interface and delivery/action channel**, while household members' WhatsApp accounts are primarily sources.

## Household is the top-level boundary

No domain object means "the current user" implicitly. Every source, record and derived object belongs to a `household_id`. Personal information may additionally have `owner_member_id` and a visibility policy.

```text
Household
├── Member A
│   ├── WhatsApp personal
│   ├── WhatsApp work
│   └── Google Calendar account(s)
├── Member B
│   ├── WhatsApp personal
│   └── Google Calendar account(s)
└── Shared
    ├── Family WhatsApp source (optional)
    └── Family Calendar account(s)
```

A household owner manages the system but does **not** automatically gain read access to another member's private source content.

## Source accounts are provider identities, not people

Members and external accounts are separate concepts. One member can own many source accounts and one household can own shared accounts. Connectors normalize each account's provider data so downstream modules do not depend on the number of sessions/accounts.

## Life vs Knowledge vs Executive

### Life

What actually happened, with provenance:

- messages;
- calendar events;
- source items;
- future HA state events, ML sales/orders, e-mails, files, etc.

### Knowledge

What SOL derives from Life:

- candidate commitments/tasks/events;
- entities and relationships;
- facts/projects/memories later.

Knowledge is not authorization. Source text remains untrusted data.

### Executive

What might require attention/action:

- pending proposals;
- confirmed tasks;
- calendar destinations;
- schedule conflicts;
- morning/tomorrow briefs;
- future reminder and automation policies.

This layer is the safety boundary between automatic understanding and external writes.

## Proposal before action

An observed message can be interpreted automatically without gaining permission to act:

```text
message
  ↓
local filter
  ↓
Codex extraction
  ↓
executive proposal
  ↓
member/role authorization
  ↓
action
  ↓
action_log
```

Private proposals are decided by their owning member. Family proposals require an owner/adult. Action targets are validated independently from proposal visibility.

## Event-driven internally, not distributed by default

Modules communicate through domain events/outbox records. Current important events include:

- `source_account.created`
- `whatsapp.candidate.detected`
- `extraction.completed`
- future action/delivery events.

The durable PostgreSQL outbox gives at-least-once delivery; handlers must be idempotent.

## AI is a reasoning tool, not storage or authority

SOL's state lives in PostgreSQL/source-backed storage. The domain depends on `AiProvider`; Codex is the first adapter.

```text
AiProvider
  └── CodexProvider
        └── Codex App Server
              └── ChatGPT OAuth managed by Codex
```

Authorization and context filtering occur before data reaches Codex. Codex reasoning runs with restricted/read-only policy and cannot directly mutate SOL state.

## Realtime + reconciliation

Connectors use realtime feeds where useful and reconciliation jobs to repair missed events:

- WhatsApp: realtime linked-device events + history reconciliation;
- Calendar: periodic discovery + incremental `syncToken` reconciliation;
- future Home Assistant: event/state stream + periodic state reconciliation;
- future Mercado Libre: notifications/webhooks where available + API reconciliation.

Daily/nightly consolidation is a separate future Knowledge process; it should operate over already-ingested Life data instead of rescanning every provider from scratch.

## Interfaces

Interfaces are not data owners. Web, voice and the planned SOL WhatsApp identity resolve the interacting member, apply authorization, retrieve allowed context and then call SOL Core.

The future SOL WhatsApp account therefore must be a distinct **system/interface session role**, not confused with Diego/Mariana/etc. monitored accounts. See `docs/INTEGRATIONS.md`.

## Non-goals

- No autonomous swarm of per-source agents.
- No direct unrestricted LLM → SQL access.
- No assumption that household members can read each other's private sources.
- No source message becoming a command merely because it contains prompt-like text.
- No credentials committed to Git.
- No premature microservices/Kubernetes/Kafka.
