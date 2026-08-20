# SOL

SOL is a family-first personal **data and knowledge system**: many people, many sources, one coherent household context layer that can be exposed to authorized AI clients through MCP.

> **Sources tell SOL what happened → Life records it → Knowledge organizes it → MCP exposes it → clients reason over it.**

External writes remain behind SOL's Executive/policy layer.

## Principles

- **Family-first, not single-user.** Records belong to a household and can have a member owner plus an explicit visibility scope.
- **Multiple accounts per provider.** Each member can connect several provider accounts; household-shared accounts are separate.
- **Source traceability.** Derived tasks/events/knowledge remain traceable to the source item that caused them.
- **Privacy before AI, MCP and UI.** Authorization filters records before they reach any reasoning client.
- **Private really means private.** Household owner/admin status does not automatically reveal another member's private records.
- **Knowledge is not authority.** Observed source content is untrusted data, not a command to SOL.
- **Models think; SOL authorizes.** MCP/LLM clients do not get raw SQL or permission bypasses.
- **Proposal before external action.** Externally visible writes stay behind Executive/action policy and audit.
- **Provider independence.** Codex is useful for optional extraction/consolidation, but SOL data access no longer depends on one AI provider.
- **No virtualization requirement.** SOL runs natively on Windows; PostgreSQL can be Neon-managed or a native local service.

## Current architecture

```text
SOURCES
member WhatsApps ─┐
Google Calendars ─┤
Home Assistant ───┼─→ Life → Knowledge → Identity/Privacy → MCP ─┬→ Codex
Mercado Libre ────┘                                             ├→ ChatGPT
                                                               └→ other clients

                                         proposals → Executive → Actions
```

## Implemented today

- household/member authentication and conservative privacy boundaries;
- PostgreSQL schema, migrations, provenance and durable event outbox;
- Neon-friendly event-driven database behavior with native Windows PostgreSQL fallback;
- multiple private/shared WhatsApp linked-device source accounts;
- encrypted WhatsApp auth/Signal state;
- realtime/history WhatsApp ingestion and deterministic candidate filtering;
- optional Codex App Server + ChatGPT OAuth enrichment/classification;
- Google Calendar multi-account sync with separate read/write calendar selection;
- executive proposals, approvals, local tasks, Calendar actions and `action_log`;
- dedicated WhatsApp de SOL interface with verified member binding;
- `/life` privacy-filtered Timeline + People + Projects;
- Home Assistant read-only source with explicit entity selection and current/live state;
- Mercado Libre read-only source with publications, recent orders and questions;
- **MCP 2026-07-28 local stdio server** with member-scoped revocable tokens;
- MCP tools for status, timeline, Life search, People, Projects, selected HA state and MeLi business summary.

## MCP — primary reasoning interface

The first MCP profile is intentionally local and read-only.

```text
MCP token
   ↓
member identity
   ↓
privacy filter
   ↓
SOL data facade
   ↓
MCP tools
```

Bootstrap:

```powershell
pnpm install
pnpm db:migrate
pnpm mcp:token
```

The token command lets the local SOL host operator choose which active member a client represents. SOL prints the secret once and stores only its SHA-256 hash in PostgreSQL.

Manual launch:

```powershell
$env:SOL_MCP_TOKEN="sol_mcp_..."
pnpm mcp
```

Current tools:

```text
sol_status
get_timeline
search_life
list_people
list_projects
get_home_state
get_business_summary
```

See [docs/MCP.md](docs/MCP.md).

## Repository layout

```text
SOL/
├── apps/server/
│   └── src/
│       ├── core/
│       ├── database/
│       ├── mcp/
│       ├── modules/
│       │   ├── identity/
│       │   ├── auth/
│       │   ├── security/
│       │   ├── life/
│       │   ├── knowledge/
│       │   ├── executive/
│       │   ├── mcp/
│       │   ├── connectors/
│       │   └── ai/codex/
│       └── ui/
├── packages/database/migrations/
├── scripts/windows/
└── docs/
```

## Quick start — Neon

Requirements: Node.js 22+ (24 recommended), pnpm and internet access. Codex CLI is optional unless AI enrichment is enabled/used.

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
/sol-whatsapp     SOL's WhatsApp interface + member binding
/executive        brief + pending proposals
/calendar         Google accounts/calendars
/whatsapp         monitored WhatsApp source accounts
/home-assistant   selected household states/events
/mercadolibre     seller/business dashboard
/ai               optional Codex enrichment setup
```

MCP is launched as a separate stdio process (`pnpm mcp`) so it can be attached directly to a compatible local client.

## Home Assistant

The current connector is deliberately read-only. An owner/adult supplies a Long-Lived Access Token, which SOL encrypts with a host-local AES-256-GCM key. SOL stores only explicitly selected entities and follows their selected state changes.

High-frequency numeric `sensor.*` entities default to snapshot mode so they do not create a Life event for every small value update. Control permissions are modeled separately and no service-call route exists yet.

See [docs/HOME_ASSISTANT.md](docs/HOME_ASSISTANT.md).

## Mercado Libre

The first Mercado Libre connector is also read-only. OAuth access/refresh tokens are encrypted with a host-local key. Publications, recent orders and questions are reconciled into SOL; orders/questions can become Life records and business context.

Mercado Libre OAuth still requires an HTTPS registered redirect URI for the real account integration. See [docs/MERCADOLIBRE.md](docs/MERCADOLIBRE.md).

## Google Calendar

Google Calendar is both a source and an action target. Read/write calendar selection is separate, and external writes originate from approved Executive proposals rather than arbitrary source content or MCP read tools.

## Database behavior

PostgreSQL is SOL's only required infrastructure service. Notifications are wake signals; durable truth remains in PostgreSQL. Redis and pgvector remain deferred until a measured need exists.

Large photos/audio/video/PDF attachments should eventually live in local/object storage, with PostgreSQL keeping structured metadata and references.

## Security note

SOL binds to `127.0.0.1` by default. Do not expose the development server directly to the internet. `.env`, `.sol/`, database credentials, MCP clear tokens, Codex OAuth data and connector encryption keys must be protected like credentials.

The initial MCP server is stdio-only. Remote MCP/HTTPS authorization is intentionally deferred.

## Current direction

The next major work is not another chatbot UI. It is:

1. improve automatic Life → Knowledge consolidation;
2. expand MCP coverage over normalized household context;
3. add Gmail/Drive/Contacts and richer files/media ingestion;
4. keep writes proposal-based behind Executive;
5. optionally let Codex or other models enrich Knowledge without becoming SOL's authority.
