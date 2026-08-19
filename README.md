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
- **Proposal before external action.** Semantic detection can be automatic; externally visible writes go through executive/action policy.
- **Provider independence.** Codex via ChatGPT OAuth is the first reasoning engine, but SOL Core is provider-neutral.
- **Modular monolith first.** One deployable system with strong module boundaries.
- **No virtualization requirement.** SOL runs natively on Windows; PostgreSQL can be Neon-managed or a native local service.

## Implemented today

```text
WhatsApp accounts ─┐
                   ├─→ Life / source_items ─→ local filter ─→ Codex extraction
Google Calendars ──┘                                      │
                                                         ▼
                                               executive proposals
                                                         │
                                           approve ──────┴────── reject
                                              │
                              ┌───────────────┴───────────────┐
                              ▼                               ▼
                         SOL task                    Google Calendar event
                              │                               │
                              └──────────→ daily brief ←──────┘
```

Current capabilities include:

- household/member authentication and privacy boundaries;
- standard PostgreSQL data model and durable outbox;
- Codex App Server + ChatGPT OAuth reasoning;
- multiple private/shared WhatsApp linked-device accounts;
- encrypted WhatsApp auth state in PostgreSQL;
- realtime/history WhatsApp ingestion and deterministic candidate filtering;
- structured Codex extraction of tasks/events/commitments/deadlines;
- multiple private/shared Google Calendar accounts;
- multiple calendars per Google account with separate **read** and **write** selection;
- offline Google OAuth refresh tokens encrypted locally;
- incremental Calendar reconciliation with `syncToken` recovery;
- source-backed Calendar events in Life;
- executive proposals with explicit approval/rejection;
- idempotent approved-event creation in Google Calendar;
- local SOL tasks for approved task/deadline proposals;
- daily and tomorrow-preview briefs per family member;
- calendar conflict detection;
- event-driven PostgreSQL outbox wakeups with slow recovery reconciliation;
- integrated web screens for Home, WhatsApp, Calendar, Day-to-day and AI.

## Repository layout

```text
SOL/
├── apps/server/                 # SOL Core runtime + web UI
│   └── src/
│       ├── core/                # event bus / outbox
│       ├── database/
│       ├── modules/
│       │   ├── identity/
│       │   ├── auth/
│       │   ├── security/
│       │   ├── connectors/
│       │   │   ├── whatsapp/
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

`pnpm db:configure` asks for a PostgreSQL connection string through a hidden PowerShell prompt and writes it only to the Git-ignored `.env` file. A TLS-enabled Neon direct connection works with the normal SOL `pg` driver and with the migration runner.

Open:

```text
http://127.0.0.1:3000/
```

Useful screens:

```text
/             SOL Home
/executive    brief + pending proposals
/calendar     Google accounts/calendars
/whatsapp     WhatsApp source accounts
/ai           Codex / ChatGPT
```

See [docs/NEON.md](docs/NEON.md) for the managed-database profile.

## Local PostgreSQL alternative

If household data should remain on the SOL machine, install PostgreSQL natively on Windows and run:

```powershell
pnpm install
pnpm db:setup
pnpm db:check
pnpm db:migrate
pnpm dev
```

`pnpm db:setup` creates the local `sol` role/database and writes its generated application password to `.env`. SOL application code is identical in both modes; only `DATABASE_URL` changes.

See [docs/WINDOWS_NATIVE.md](docs/WINDOWS_NATIVE.md).

## Cloud-friendly database behavior

The runtime is designed not to keep a scale-to-zero database artificially awake:

```text
transaction inserts event_outbox row
             ↓
PostgreSQL trigger emits NOTIFY after commit
             ↓
short-lived SOL pool connection receives notification
             ↓
outbox dispatcher wakes immediately
             ↓
handler runs
```

Notifications are only wake signals; the durable truth remains in the `event_outbox` table. If a process crashes or a cloud database suspends and loses session state, a slow recovery sweep processes anything still unpublished.

Default runtime behavior keeps the connection pool small, releases idle clients quickly and spaces Calendar/executive reconciliation widely enough to permit meaningful idle windows.

## Database philosophy

PostgreSQL is the only infrastructure service SOL currently requires. Sessions, durable outbox events, sync cursors, tasks, proposals, briefs and connector state all live there.

Redis was removed because no current module used it. Semantic vector search is also deferred: the base schema does not require pgvector. When semantic retrieval becomes useful, pgvector can return as an optional dedicated migration rather than a prerequisite.

Large binary content should not live in PostgreSQL. Future photos, audio, PDFs and attachments should be stored locally or in object storage, while PostgreSQL retains metadata/references.

## Google Calendar setup

Create an OAuth **Web application** client in Google Cloud and register the exact local callback configured in `.env`:

```text
http://127.0.0.1:3000/v1/google/callback
```

Then set:

```dotenv
SOL_GOOGLE_CLIENT_ID=...
SOL_GOOGLE_CLIENT_SECRET=...
SOL_GOOGLE_REDIRECT_URI=http://127.0.0.1:3000/v1/google/callback
```

From `/calendar`, create a personal or family Google Calendar source account and complete OAuth. SOL discovers the calendars in that Google account. Reading and writing are deliberately separate selections: several calendars may feed SOL, but only one per source account is selected as the default write target.

OAuth access/refresh tokens are encrypted before PostgreSQL storage with a local key under:

```text
.sol/secrets/google-oauth.key
```

Backups require both the database and the corresponding local encryption keys.

## Executive action boundary

A message such as:

```text
"El viernes a las 15 paso a buscar la sembradora"
```

can become a structured proposal automatically, but **does not immediately alter Calendar**.

```text
WhatsApp candidate
      ↓
Codex extraction
      ↓
pending executive proposal
      ↓
member approval
      ↓
SOL task OR Google Calendar event
      ↓
action_log
```

Private proposals can only be decided by their member owner. Family proposals require an owner/adult. Private proposals write only to a writable Calendar account owned by that member; family proposals write only to an explicitly shared household Calendar account.

## Planned integrations already considered in the architecture

SOL will eventually have **its own WhatsApp account**. That account is planned as an assistant interface/action channel for briefs, reminders, questions and approvals—not merely another monitored personal source.

Home Assistant and the Mercado Libre API are planned as first-class source/action connectors. Their provider-specific code should plug into the same Life → Knowledge → Executive → Actions flow rather than becoming separate assistant silos.

See [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) and [docs/ROADMAP.md](docs/ROADMAP.md).

## Security note

SOL binds to `127.0.0.1` by default. Do not expose the development server directly to the internet. `.env`, `.sol/`, database credentials, Codex OAuth data, WhatsApp auth encryption keys and Google OAuth encryption keys are ignored by Git and must be protected like credentials.

## Current status

Phases 0–3 are implemented and the **core of Phase 4 (Calendar + executive loop) is implemented**. Neon is the preferred prototype database profile, with native local PostgreSQL retained as an alternative. Real OAuth/linked-device integration tests still need to be run on the target SOL host. The next planned product phase is SOL's own WhatsApp communication channel, while nightly consolidation and richer proposal editing remain Phase 4 follow-ups.
