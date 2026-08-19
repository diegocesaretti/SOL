# SOL

SOL is a family-first personal information and automation system: one integrated assistant, many people, many sources, one coherent household knowledge layer.

> **Sources tell SOL what happened → Life records it → Knowledge understands it → SOL decides → Actions execute.**

## Principles

- **Family-first, not single-user.** Records belong to a household and can have a member owner plus an explicit visibility scope.
- **Multiple accounts per provider.** Each member can connect several WhatsApp/Google/future accounts; household-shared accounts are separate.
- **Source traceability.** Derived tasks/events/knowledge remain traceable to the source item that caused them.
- **Privacy before AI.** Authorization filters context before it reaches Codex.
- **Private really means private.** Household owner/admin status does not automatically reveal another member's private records.
- **Knowledge is not authority.** Observed WhatsApp/e-mail/source content is untrusted data, not a command to SOL.
- **Interfaces establish authority.** A verified member talking directly to SOL is different from third-party text merely observed by a connector.
- **Proposal before external action.** Semantic detection can be automatic; externally visible writes go through executive/action policy.
- **Provider independence.** Codex via ChatGPT OAuth is the first reasoning engine, but SOL Core is provider-neutral.
- **Modular monolith first.** One deployable system with strong module boundaries.
- **No virtualization requirement.** SOL runs natively on Windows; PostgreSQL can be Neon-managed or a native local service.

## Implemented today

```text
SOURCES
member WhatsApps ─┐
Google Calendars ─┼─→ Life → Knowledge → Executive → Actions
future HA / ML ───┘                         │
                                             │
INTERFACES                                   │
Web ─────────────────────────────────────────┤
SOL WhatsApp ↔ verified family members ──────┘
```

Current capabilities include:

- household/member authentication and privacy boundaries;
- standard PostgreSQL data model and durable outbox;
- Neon-friendly event-driven database behavior;
- Codex App Server + ChatGPT OAuth reasoning;
- multiple private/shared WhatsApp linked-device **source** accounts;
- encrypted WhatsApp auth state in PostgreSQL;
- realtime/history WhatsApp ingestion and deterministic candidate filtering;
- structured Codex extraction of tasks/events/commitments/deadlines;
- multiple private/shared Google Calendar accounts;
- separate Calendar read/write selection;
- incremental Calendar reconciliation with source-backed Life events;
- executive proposals with explicit approval/rejection;
- idempotent approved-event creation in Google Calendar;
- local SOL tasks;
- daily/tomorrow briefs and conflict detection;
- a dedicated **WhatsApp de SOL** assistant account, separate from monitored sources;
- one-time member → actual WhatsApp JID/LID identity binding;
- direct questions, today/tomorrow briefs and pending-proposal queries over SOL WhatsApp;
- authenticated create requests → pending proposal → explicit confirmation;
- deterministic `sí/no` and proposal-reference approvals using Executive Core permissions;
- automatic brief/proposal delivery over SOL WhatsApp;
- outbound assistant-message auditing through `action_log`.

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
│       │   ├── connectors/
│       │   │   ├── whatsapp/          # monitored source accounts
│       │   │   ├── sol-whatsapp/      # SOL's own assistant interface
│       │   │   └── google-calendar/
│       │   ├── ai/codex/
│       │   ├── knowledge/
│       │   └── executive/
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

Requirements: Node.js 22+ (24 recommended), pnpm, internet access, and the Codex CLI if the AI engine is enabled.

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
/sol-whatsapp   SOL's own WhatsApp interface + member binding
/executive      brief + pending proposals
/calendar       Google accounts/calendars
/whatsapp       monitored WhatsApp source accounts
/ai             Codex / ChatGPT
```

See [docs/NEON.md](docs/NEON.md) and [docs/SOL_WHATSAPP.md](docs/SOL_WHATSAPP.md).

## Local PostgreSQL alternative

If household data should remain on the SOL machine, install PostgreSQL natively on Windows and run:

```powershell
pnpm install
pnpm db:setup
pnpm db:check
pnpm db:migrate
pnpm dev
```

Only `DATABASE_URL` changes; SOL application behavior is the same. See [docs/WINDOWS_NATIVE.md](docs/WINDOWS_NATIVE.md).

## WhatsApp: source vs assistant

SOL intentionally has two different WhatsApp roles:

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

The dedicated assistant account does not sync ordinary history into Life. Members authenticate their WhatsApp by generating a short-lived challenge while already logged into SOL and sending it directly to the dedicated SOL number. The protocol-visible JID is then bound to that member.

A request such as:

```text
agendame dentista el viernes a las 16
```

becomes:

```text
authenticated SOL WhatsApp command
        ↓
Codex structures it (no write authority)
        ↓
pending executive proposal
        ↓
SOL asks for confirmation
        ↓
sí / no
        ↓
Executive Core authorization
        ↓
Calendar/task action + action_log
```

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

Home Assistant and Mercado Libre API are already part of the architecture as future **source + action** connectors. They will feed the same Life → Knowledge → Executive flow and become available to web, SOL WhatsApp and voice through the same permission layer.

See [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) and [docs/ROADMAP.md](docs/ROADMAP.md).

## Security note

SOL binds to `127.0.0.1` by default. Do not expose the development server directly to the internet. `.env`, `.sol/`, database credentials, Codex OAuth data, WhatsApp auth encryption keys and Google OAuth encryption keys are ignored by Git and must be protected like credentials.

## Current status

Phases 0–3 are implemented; Phase 4 (Calendar + executive loop) and **Phase 5 (SOL WhatsApp communication channel) are implemented at core level**. Real Google OAuth, monitored WhatsApp and dedicated SOL WhatsApp integration tests still need to run on the target host. The next larger product phase is the family UI/knowledge layer, while Home Assistant and Mercado Libre remain planned first-class connectors.
