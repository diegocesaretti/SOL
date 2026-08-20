# SOL integration map

SOL treats an integration by **role**, not only by provider. A provider can be a source of household information, an action target, an assistant interface, or several of these at once.

## Core rule

```text
external systems
      ↓
Sources → Life → Knowledge → Identity/Privacy → MCP → reasoning clients
                              │
                              └→ Executive → Actions
```

Source adapters never become the executive brain. They normalize provider data into SOL. MCP exposes already-authorized context. Actions are permissioned separately from reads.

## MCP — primary reasoning/client interface

The first MCP server is local stdio and read-only. A revocable SOL token resolves to one active household member before any data query runs.

Current MCP reads:

- SOL/source status;
- Life timeline;
- Life text search;
- People/Projects knowledge;
- selected Home Assistant current state;
- Mercado Libre business summary.

MCP does not expose raw SQL, connector credentials or direct write actions. Future writes should create Executive proposals rather than bypassing policy.

See `docs/MCP.md`.

## WhatsApp

WhatsApp has two deliberately different roles.

### Household WhatsApp source accounts

Linked-device accounts belonging to members or explicitly to the household feed messages/conversations into Life. Private accounts stay private to their owning member even when another member is household owner/admin.

### SOL's own WhatsApp account

The dedicated household WhatsApp is an **interface and delivery/action channel**, not a canonical data source or canonical reasoning engine.

It can:

- identify verified members through one-time binding;
- deliver briefs/proposals;
- receive questions and create requests;
- accept deterministic proposal approvals;
- audit outbound messages.

Over time its read/question path should reuse the same data facade that MCP exposes so every interface sees consistent authorized context.

## Google Calendar — source + action target

- multiple Google accounts per member/household;
- multiple calendars discovered per account;
- reading and writing selections are separate;
- private source accounts produce private Life events;
- shared source accounts produce family Life events;
- external writes originate from approved Executive proposals and are audited.

Calendar read tools can be added to MCP without exposing direct calendar-write capability.

## Home Assistant — source, future action target

Current role: **source**.

The connector provides encrypted credentials, entity discovery, explicit entity selection, snapshot/change persistence and selected realtime state changes. Selected current state is available through MCP's read-only facade.

An entity being readable by SOL/MCP does not make it controllable. Future control requires per-entity/service grants, stronger approval for risky domains (locks/alarms/security) and `action_log` auditing.

## Mercado Libre — business source, future action target

Current role: **business source**.

The connector provides OAuth/PKCE credentials, seller identity reconciliation, publication snapshots, recent orders/questions and a business dashboard. A compact permission-filtered summary is exposed through MCP.

Observed buyer questions/orders are business data, not commands. Private seller accounts remain private to their owner.

Future listing/stock/price/reply actions must route through Executive/action policy and audit.

## Codex / AI providers — optional enrichment

Codex is the first `AiProvider`, useful for classification, extraction and consolidation of unstructured data. It is no longer the required consumer/frontend for SOL.

An MCP-capable client can reason over SOL without Codex being logged in. Conversely, SOL can still call Codex internally for selected background enrichment jobs.

## Other planned sources

Gmail, files/Drive, Contacts, voice and future sources should implement the same provider-neutral ingestion contracts. Once normalized into Life/Knowledge, they become available to authorized clients without provider-specific rewrites in each AI frontend.
