# SOL

SOL is a family-first personal information and automation system: one integrated assistant, many people, many sources, one coherent household knowledge layer.

> **Sources tell SOL what happened → Life records it → Knowledge understands it → SOL decides → Actions execute.**

## Principles

- **Family-first, not single-user.** Records belong to a household and can have a member owner plus an explicit visibility scope.
- **Multiple accounts per provider.** Each member can connect several provider accounts; household-shared accounts are separate.
- **Source traceability.** Derived tasks/events/knowledge remain traceable to the source item that caused them.
- **Privacy before AI and UI.** Authorization filters records before they reach Codex or user-facing views.
- **Private really means private.** Household owner/admin status does not automatically reveal another member's private records.
- **Knowledge is not authority.** Observed source content is untrusted data, not a command to SOL.
- **Interfaces establish authority.** A verified member talking directly to SOL is different from third-party text observed by a connector.
- **Proposal before external action.** Semantic detection can be automatic; externally visible writes go through executive/action policy.
- **Provider independence.** Codex is the first reasoning engine, but SOL Core remains provider-neutral.
- **No virtualization requirement.** SOL runs natively on Windows; PostgreSQL can be Neon-managed or a native local service.

## Current architecture

```text
SOURCES
member WhatsApps ─┐
Google Calendars ─┼─→ Life → Knowledge → Executive → Actions
future HA / ML ───┘        │        │          │
                           │        │          │
                           └── Timeline         │
                                People/Projects │
                                               │
INTERFACES                                     │
Web ───────────────────────────────────────────┤
SOL WhatsApp ↔ verified family members ────────┘
```

## Implemented today

- household/member authentication and conservative privacy boundaries;
- PostgreSQL schema, migrations, provenance and durable event outbox;
- Neon-friendly event-driven database behavior with native Windows PostgreSQL fallback;
- Codex App Server + ChatGPT OAuth reasoning;
- multiple private/shared WhatsApp linked-device **source** accounts;
- encrypted WhatsApp auth/Signal state;
- realtime/history WhatsApp ingestion and deterministic candidate filtering;
- structured Codex extraction of tasks/events/commitments/deadlines;
- Google Calendar multi-account sync with separate read/write calendar selection;
- executive proposals, approvals, local tasks, Calendar actions and `action_log`;
- daily/tomorrow briefs and schedule conflicts;
- dedicated **WhatsApp de SOL** assistant account, separate from monitored sources;
- one-time member → actual WhatsApp JID/LID binding;
- questions, briefs, create requests and deterministic proposal approvals over SOL WhatsApp;
- `/life` privacy-filtered timeline of source items, Life events and tasks;
- `/life` People/Projects knowledge views with aliases/facts;
- WhatsApp identities promoted to Person entities using source-matched privacy;
- manual private/family Person and Project creation.

## Repository layout

```text
SOL/
├── apps/server/
│   └── src/
│       ├── core/
│       ├── database/
│       ├── modules/
│       │   ├── identity/
│       │   ├── auth/
│       │   ├── security/
│       │   ├── life/
│       │   ├── knowledge/
│       │   ├── executive/
│       │   ├── connectors/
│       │   │   ├── whatsapp/          # monitored sources
│       │   │   ├── sol-whatsapp/      # assistant interface
│       │   │   └── google-calendar/
│       │   └── ai/codex/
│       └── ui/
├── packages/database/migrations/
├── scripts/windows/
└── docs/
    ├── ARCHITECTURE.md
    ├── NEON.md
    ├── WINDOWS_NATIVE.md
    ├── CODEX.md
    ├── WHATSAPP.md
    ├── SOL_WHATSAPP.md
    ├── INTEGRATIONS.md
    ├── DATA_MODEL.md
    ├── SECURITY.md
    └── ROADMAP.md
```

## Quick start — Neon (recommended prototype profile)

Requirements: Node.js 22+ (24 recommended), pnpm, internet access, and Codex CLI if AI reasoning is enabled.

**Docker Desktop, WSL, Hyper-V, Redis, pgvector and a local PostgreSQL installation are not required.**

```powershell
pnpm install
pnpm db:configure
pnpm db:check
pnpm db:migrate
pnpm dev
```

`pnpm db:configure` asks for a PostgreSQL connection string through a hidden PowerShell prompt and writes it only to the Git-ignored `.env` file.

Open:

```text
http://127.0.0.1:3000/
```

Useful screens:

```text
/               SOL Home
/life           Timeline + People + Projects
/sol-whatsapp   SOL's own WhatsApp interface + member binding
/executive      brief + pending proposals
/calendar       Google accounts/calendars
/whatsapp       monitored WhatsApp source accounts
/ai             Codex / ChatGPT
```

See [docs/NEON.md](docs/NEON.md), [docs/SOL_WHATSAPP.md](docs/SOL_WHATSAPP.md) and [docs/ROADMAP.md](docs/ROADMAP.md).

## Local PostgreSQL alternative

If household data should remain on the SOL machine:

```powershell
pnpm install
pnpm db:setup
pnpm db:check
pnpm db:migrate
pnpm dev
```

Only `DATABASE_URL` changes; SOL application behavior is the same. See [docs/WINDOWS_NATIVE.md](docs/WINDOWS_NATIVE.md).

## WhatsApp: source vs assistant

```text
Member's ordinary WhatsApp
       ↓
monitored SOURCE
       ↓
third-party text = untrusted data

Dedicated WhatsApp de SOL
       ↕
verified MEMBER INTERFACE
       ↓
questions / proposals / approvals
```

The assistant account skips normal history ingestion. A member binds their direct WhatsApp identity by generating a short-lived code from an authenticated SOL web session and sending it to the dedicated SOL account. `sí/no` is scoped to the last proposal SOL explicitly asked that member about.

## Life and Knowledge

`/life` is built from permission-filtered queries rather than fetching household data and hiding it afterwards.

```text
Timeline
├── visible source items
├── visible Life events
└── visible tasks

Knowledge
├── People
│   ├── aliases
│   └── visible facts
└── Projects
    ├── aliases
    └── visible facts
```

Manual People/Projects may be `private` or `family`. WhatsApp-derived People inherit a conservative privacy scope from the source that first established the identity. More complete cross-source/entity consolidation remains a later Knowledge job.

## Database behavior

PostgreSQL is SOL's only required infrastructure service. Notifications are wake signals; durable truth remains in `event_outbox`. A slow recovery pass handles missed wakeups. Redis and pgvector remain deferred until a measured need exists.

Large photos/audio/video/PDF attachments should eventually live in local/object storage, with PostgreSQL keeping structured metadata and references.

## Google Calendar setup

Create an OAuth **Web application** client in Google Cloud and register:

```text
http://127.0.0.1:3000/v1/google/callback
```

Set in `.env`:

```dotenv
SOL_GOOGLE_CLIENT_ID=...
SOL_GOOGLE_CLIENT_SECRET=...
SOL_GOOGLE_REDIRECT_URI=http://127.0.0.1:3000/v1/google/callback
```

OAuth credentials are encrypted before PostgreSQL storage with a local key under `.sol/secrets/google-oauth.key`.

## Planned first-class connectors

Home Assistant and Mercado Libre API remain planned **source + action** connectors. They will feed the same Life → Knowledge → Executive flow and become available to Web, SOL WhatsApp and voice through the same permission layer.

See [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

## Security note

SOL binds to `127.0.0.1` by default. Do not expose the development server directly to the internet. `.env`, `.sol/`, database credentials, Codex OAuth data, WhatsApp auth encryption keys and Google OAuth encryption keys are ignored by Git and must be protected like credentials.

## Current status

Phases 0–3 are implemented; Phase 4 (Calendar/executive) and Phase 5 (SOL WhatsApp) are implemented at core level. **Phase 6 is underway with the Timeline and People/Projects core already implemented.** Real Google OAuth and both WhatsApp linked-device flows still need integration tests on the target host.
