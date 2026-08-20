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
Google Calendars ─┤
Home Assistant ───┼─→ Life → Knowledge → Executive → Actions
Mercado Libre ────┘        │        │          │
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
- `/life` privacy-filtered Timeline + People + Projects;
- Home Assistant read-only source with explicit entity selection, state snapshots and selected live changes;
- Mercado Libre read-only seller source with OAuth/PKCE, publications, recent orders and questions;
- private/shared business-account boundaries and a local business dashboard.

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
│       │   │   ├── whatsapp/
│       │   │   ├── sol-whatsapp/
│       │   │   ├── google-calendar/
│       │   │   ├── home-assistant/
│       │   │   └── mercadolibre/
│       │   └── ai/codex/
│       └── ui/
├── packages/database/migrations/
├── scripts/windows/
└── docs/
```

## Quick start — Neon

Requirements: Node.js 22+ (24 recommended), pnpm, internet access, and Codex CLI if AI reasoning is enabled.

```powershell
pnpm install
pnpm db:configure
pnpm db:check
pnpm db:migrate
pnpm test
pnpm typecheck
pnpm dev
```

Open:

```text
http://127.0.0.1:3000/
```

Useful screens:

```text
/                 SOL Home
/life             Timeline + People + Projects
/sol-whatsapp     SOL's own WhatsApp interface + member binding
/executive        brief + pending proposals
/calendar         Google accounts/calendars
/whatsapp         monitored WhatsApp source accounts
/home-assistant   selected household states/events
/mercadolibre     seller/business dashboard
/ai               Codex / ChatGPT
```

## Home Assistant

The current connector is deliberately read-only. An owner/adult supplies a Long-Lived Access Token, which SOL encrypts with a host-local AES-256-GCM key. SOL discovers `/api/states`, stores only explicitly selected entities, and subscribes to selected `state_changed` events over the Home Assistant WebSocket API.

High-frequency numeric `sensor.*` entities default to snapshot mode so they do not create a Life event for every small value update. Control permissions are modeled separately and no service-call route exists yet.

See [docs/HOME_ASSISTANT.md](docs/HOME_ASSISTANT.md).

## Mercado Libre

The first Mercado Libre connector is also read-only:

```text
Mercado Libre OAuth + PKCE
          ↓
 seller identity / publications / recent orders / questions
          ↓
      PostgreSQL snapshots
          ↓
 orders + questions → Life
          ↓
       /mercadolibre
```

OAuth access/refresh tokens are AES-256-GCM encrypted with a host-local key. Refresh is serialized because Mercado Libre refresh tokens are single-use and rotate on each refresh.

Mercado Libre currently requires the registered OAuth redirect URI to be **HTTPS** and static. Configure:

```dotenv
SOL_MERCADOLIBRE_CLIENT_ID=...
SOL_MERCADOLIBRE_CLIENT_SECRET=...
SOL_MERCADOLIBRE_REDIRECT_URI=https://your-sol-host.example/v1/mercadolibre/callback
SOL_MERCADOLIBRE_AUTH_URL=https://auth.mercadolibre.com.ar/authorization
SOL_MERCADOLIBRE_SYNC_MS=3600000
```

Enable PKCE in the Mercado Libre application settings. Until SOL has a public HTTPS notification endpoint, the connector reconciles periodically and can also be synced manually from `/mercadolibre`.

See [docs/MERCADOLIBRE.md](docs/MERCADOLIBRE.md).

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

## Database behavior

PostgreSQL is SOL's only required infrastructure service. Notifications are wake signals; durable truth remains in `event_outbox`. A slow recovery pass handles missed wakeups. Redis and pgvector remain deferred until a measured need exists.

Large photos/audio/video/PDF attachments should eventually live in local/object storage, with PostgreSQL keeping structured metadata and references.

## Security note

SOL binds to `127.0.0.1` by default. Do not expose the development server directly to the internet. `.env`, `.sol/`, database credentials, Codex OAuth data and connector encryption keys are ignored by Git and must be protected like credentials.

A reverse proxy/public HTTPS endpoint for Mercado Libre OAuth or future webhooks must be hardened separately from the localhost development profile.

## Current status

Phases 0–3 are implemented; Phase 4 (Calendar/executive) and Phase 5 (SOL WhatsApp) are implemented at core level. Phase 6 is underway with Timeline and People/Projects already implemented. Home Assistant and Mercado Libre now have **read-only source cores**; both still need real integration tests on the target SOL host.
