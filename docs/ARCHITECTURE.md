# SOL architecture

## Architectural style

SOL is a **family-first personal data/knowledge OS** implemented as a modular monolith: one deployable core process and one primary PostgreSQL database, with explicit module boundaries. Operationally simple now, extractable later.

SOL's primary responsibility is no longer to be a proprietary conversational brain. It is to collect, normalize, organize, protect and expose useful household/business context.

## Default operational profile

The target host is native Windows without virtualization:

```text
Windows
├── SOL Core (Node.js)
├── source connectors
├── MCP stdio server
├── optional Codex CLI / App Server
└── PostgreSQL via DATABASE_URL (Neon recommended; native PostgreSQL fallback)
```

Docker Desktop, WSL, Hyper-V, Redis and pgvector are not architectural requirements. Redis can be introduced later only if measured queue/cache coordination needs justify it; pgvector remains optional until semantic retrieval needs it.

## End-to-end flow

```text
SOURCES
WhatsApp / Google Calendar / Home Assistant / Mercado Libre / future Gmail / files / ...
                               │
                               ▼
                          CONNECTORS
                               │
                               ▼
                              LIFE
               normalized records + provenance
                               │
                               ▼
                           KNOWLEDGE
              entities / facts / relations / projects
                               │
                               ▼
                    IDENTITY + PRIVACY POLICY
                               │
                  ┌────────────┴────────────┐
                  ▼                         ▼
                 MCP                    EXECUTIVE
         read/context interface      proposal/action policy
                  │                         │
        ┌─────────┼─────────┐               ▼
        ▼         ▼         ▼             ACTIONS
      Codex    ChatGPT    other        Calendar / HA / ML / ...
      client    client    agents
```

A provider may occupy more than one role. Google Calendar is both a source and an action target. Home Assistant and Mercado Libre start as sources and can later become action targets behind explicit policy.

## Core rule

**Models think. SOL owns data, identity, privacy, provenance and authorization.**

No MCP client, LLM provider or source connector is trusted as the authority for household permissions.

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
    ├── Home Assistant
    └── shared business/calendar sources
```

A household owner manages the system but does **not** automatically gain read access to another member's private source content.

## Source accounts are provider identities, not people

Members and external accounts are separate concepts. One member can own many source accounts and one household can own shared accounts. Connectors normalize each provider's data so downstream Life/Knowledge/MCP consumers do not depend on provider-specific account layouts.

## Life vs Knowledge vs Executive

### Life

What actually happened, with provenance:

- messages;
- calendar events;
- Home Assistant state changes;
- Mercado Libre sales/orders/questions;
- tasks;
- future e-mails, files and other observations.

Life should remain source-backed and auditable.

### Knowledge

What SOL understands/consolidates from Life:

- people and aliases;
- projects;
- facts and relationships;
- routines/schedules;
- candidate commitments/tasks/events;
- durable memories derived from multiple source records.

Knowledge is not authorization. Derived facts retain provenance/visibility rules and source text remains untrusted data.

### Executive

Executive becomes a **small safety/action layer**, not the central conversational brain. It owns:

- pending proposals;
- confirmed tasks;
- approval policy;
- action destinations;
- conflict/risk checks;
- action auditing.

This is the boundary between automatic organization and external mutation.

## MCP is the primary reasoning interface

SOL exposes permission-filtered information through MCP so multiple clients can reason over the same data without SOL depending on one AI provider.

Initial local profile:

```text
MCP token → member identity → privacy filter → read-only tools
```

Current tools include timeline, Life search, People, Projects, selected Home Assistant state and Mercado Libre business summary.

The initial transport is local `stdio`. Remote MCP is deferred until HTTPS and remote authorization are hardened.

See `docs/MCP.md`.

## Proposal before action

Observed information can be interpreted automatically without acquiring permission to act:

```text
source observation
  ↓
normalization / optional extraction
  ↓
Life / Knowledge
  ↓
MCP client or SOL rule proposes action
  ↓
Executive policy
  ↓
member/role authorization
  ↓
action
  ↓
action_log
```

Private proposals are decided by their owning member. Family proposals require appropriate household authority. Action targets are validated independently from data visibility.

## Event-driven internally, not distributed by default

Modules communicate through domain events/outbox records. The durable PostgreSQL outbox gives at-least-once delivery; handlers must be idempotent. PostgreSQL remains the single persistence/co-ordination dependency for the current scale.

## AI is optional enrichment, not storage or authority

SOL state lives in PostgreSQL/source-backed storage. AI providers may help with unstructured-data jobs, but normal data access and MCP do not require Codex to be logged in.

```text
optional AI enrichment
        │
        ├── classify candidate
        ├── extract people/facts
        ├── consolidate Life → Knowledge
        └── summarize

AiProvider
  └── CodexProvider (first adapter)
```

Authorization and context filtering occur before data reaches an AI provider. AI reasoning cannot directly mutate SOL state.

## Realtime + reconciliation

Connectors use realtime feeds where useful and reconciliation jobs to repair missed events:

- WhatsApp: realtime linked-device events + history reconciliation;
- Calendar: periodic discovery + incremental sync-token reconciliation;
- Home Assistant: realtime state stream + current-state reconciliation;
- Mercado Libre: bounded API reconciliation now, webhooks later.

A future daily/nightly Life → Knowledge consolidator should operate over already-ingested Life data instead of rescanning every provider from scratch.

## Interfaces

Interfaces are not data owners. Web, SOL WhatsApp, voice and MCP clients resolve an interacting member, apply authorization and retrieve only allowed context.

The dedicated SOL WhatsApp account remains an assistant interface/delivery channel, but it is no longer the canonical reasoning interface. It can itself consume the same SOL data facade used by MCP.

## Non-goals

- No autonomous swarm of per-source agents.
- No direct unrestricted LLM → SQL access.
- No assumption that household members can read each other's private sources.
- No source message becoming a command merely because it contains prompt-like text.
- No MCP token becoming an admin bypass.
- No credentials committed to Git.
- No mandatory Docker/WSL/Hyper-V layer on the Windows target host.
- No premature microservices/Kubernetes/Kafka.
