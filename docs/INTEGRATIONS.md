# SOL integration map

SOL treats an integration by **role**, not only by provider. A provider can be a source of household information, an action target, an assistant interface, or several of these at once.

## Core rule

```text
external systems
      ↓
Sources → Life → Knowledge → Executive → Actions
                                  ↑
                             Interfaces
```

Source adapters never become the executive brain. They normalize provider data into SOL. Actions are permissioned separately from reads. Interfaces identify the member who is interacting before retrieving private context or executing anything.

## WhatsApp

WhatsApp has two deliberately different roles.

### Household WhatsApp source accounts

These are linked-device accounts belonging to members or explicitly to the household:

```text
Diego WhatsApp    → personal source
Mariana WhatsApp  → personal source
shared account    → family source
```

They feed messages/conversations into Life. Private accounts stay private to their owning member even when another member is a household owner/admin.

### SOL's own WhatsApp account — implemented core

SOL can also have one dedicated household WhatsApp identity/account used to **communicate with household members**. This account is not an ordinary monitored source. It is an assistant interface plus delivery/action channel.

Implemented responsibilities:

- send persisted morning/tomorrow briefs;
- deliver executive proposals to the member allowed to decide them;
- receive direct questions from verified household members;
- receive natural-language create requests that become pending proposals rather than immediate actions;
- accept deterministic `sí/no` approval for the last proposal SOL explicitly asked that member about;
- accept approve/reject commands by proposal reference;
- audit outbound assistant messages through `action_log`.

Member authentication uses a one-time challenge generated from an already authenticated SOL web session. The member sends that code from their own WhatsApp to SOL; the actual WhatsApp JID/LID seen by the protocol is then bound to the member. A phone/display name is not treated as sufficient authentication.

Unknown senders, groups, broadcasts and messages observed in members' ordinary chats never gain command authority. The dedicated assistant account also skips normal WhatsApp history ingestion and candidate extraction so assistant conversations do not masquerade as source observations.

See `docs/SOL_WHATSAPP.md` for setup, binding and command details.

## Google Calendar

Current role: **source + action target**.

- multiple Google accounts per member/household;
- multiple calendars discovered per account;
- reading and writing selections are separate;
- private source accounts produce private Life events;
- shared source accounts produce family Life events;
- external writes originate from approved executive proposals and are audited.

## Home Assistant — planned source/action target

Home Assistant will be a first-class source of household state/events, not a special AI tool bolted onto prompts.

Candidate source data includes:

- device/entity state changes;
- presence/occupancy events;
- alarms and important automations;
- environmental/sensor history where useful;
- energy and household infrastructure data.

It can also be an action target. Read and write capabilities must remain separate so an entity can be visible to SOL without automatically being controllable. Riskier actions require stronger approval policies than harmless reads.

## Mercado Libre API — planned source/action target

Mercado Libre will be a business source tied to the relevant household member/business context rather than mixed indiscriminately with family/private data.

Candidate source data includes:

- orders/sales;
- messages/questions;
- listings;
- stock and pricing signals;
- shipping/payment state;
- business alerts and metrics.

Future actions (listing updates, replies, pricing/stock changes, etc.) must use explicit permissions and `action_log`. Business visibility scopes/projects can keep this context separate from unrelated household information.

## Other planned sources

Gmail, files/Drive, contacts, voice, Home Assistant, Mercado Libre and future sources should implement the same provider-neutral ingestion/action contracts. SOL's core data model and executive loop should not need provider-specific rewrites when one is added.
