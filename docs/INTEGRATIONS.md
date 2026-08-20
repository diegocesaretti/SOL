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
member WhatsApp  → personal source
shared account   → family source
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

See `docs/SOL_WHATSAPP.md`.

## Google Calendar — source + action target

- multiple Google accounts per member/household;
- multiple calendars discovered per account;
- reading and writing selections are separate;
- private source accounts produce private Life events;
- shared source accounts produce family Life events;
- external writes originate from approved executive proposals and are audited.

## Home Assistant — implemented read-only source, future action target

Current role: **source**.

The implemented connector provides:

- household Home Assistant account with encrypted Long-Lived Access Token;
- REST entity discovery/current-state reconciliation;
- explicit entity selection;
- `snapshot` versus `changes` persistence policy;
- selected realtime `state_changed` stream;
- Life/source items for selected meaningful state transitions;
- no service-call/control endpoint.

The schema intentionally keeps future control separate from source visibility. An entity being readable by SOL does not make it controllable. Future control must add per-entity/service grants, stronger approval for risky domains such as locks/alarms/security and `action_log` auditing.

See `docs/HOME_ASSISTANT.md`.

## Mercado Libre — implemented read-only business source, future action target

Current role: **business source**.

The implemented connector provides:

- personal or shared-business Mercado Libre source accounts;
- Authorization Code OAuth with `state` + S256 PKCE;
- encrypted rotating access/refresh credentials;
- seller identity reconciliation;
- bounded publication snapshots;
- recent seller orders;
- recent questions;
- orders/questions represented in Life with source-matched privacy;
- `/mercadolibre` local business dashboard;
- periodic/manual reconciliation.

The read-only connector deliberately does not expose listing, stock, price, shipping, payment or question-reply writes. Observed buyer questions/orders are business data, not commands to SOL.

A private Mercado Libre account remains private to its owner. Household admins may see that a personal source exists in source inventory without gaining access to that account's seller identity, orders, questions or dashboard.

Future Mercado Libre actions must be separate capabilities routed through Executive/action policy and `action_log`. A public HTTPS deployment can later add notification-driven reconciliation for orders/items/questions/shipments/payments/messages while retaining polling as recovery.

See `docs/MERCADOLIBRE.md`.

## Other planned sources

Gmail, files/Drive, contacts, voice and future sources should implement the same provider-neutral ingestion/action contracts. SOL's core data model and executive loop should not need provider-specific rewrites when one is added.
