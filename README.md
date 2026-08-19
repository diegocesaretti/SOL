# SOL

SOL is a family-first personal information and automation system: one integrated assistant, many people, many sources, one coherent household knowledge layer.

> **Sources tell SOL what happened → Life records it → Knowledge understands it → SOL decides → Actions execute.**

## Principles

- **Family-first, not single-user.** Every meaningful record belongs to a household and can have an owner, participants and an explicit visibility scope.
- **Multiple accounts per provider.** A member may connect several WhatsApp, Google or other accounts; shared household accounts are also supported.
- **Source traceability.** Derived facts, tasks and memories must be traceable back to the source material that caused them.
- **Privacy before AI.** Authorization filters context before it is sent to an AI provider.
- **Private really means private.** Household owner/admin status does not automatically grant access to another member's private records.
- **One executive brain.** Connectors and deterministic modules collect and structure information; the assistant reasons only when reasoning is useful.
- **Provider independence.** Codex via ChatGPT authentication is the first reasoning provider, but SOL's domain does not depend directly on Codex.
- **Modular monolith first.** Keep deployment simple while preserving module boundaries that can later be extracted if needed.

## Current stack

- Node.js + TypeScript
- PostgreSQL + pgvector
- Redis (reserved for jobs/cache/event coordination)
- Docker Compose for local infrastructure
- Persistent member sessions with `scrypt` password hashing
- Durable event outbox + runtime dispatcher
- Provider-neutral `AiProvider`
- Codex App Server adapter using ChatGPT OAuth
- Isolated SOL Codex credential profile under `.sol/codex`
- Baileys 7 multi-session WhatsApp linked-device connector
- Encrypted PostgreSQL WhatsApp authentication state
- Local candidate filtering before AI reasoning

## Repository layout

```text
SOL/
├── apps/
│   └── server/              # SOL Core HTTP/runtime + integrated web UI
├── packages/
│   └── database/            # SQL migrations
├── docs/
│   ├── ARCHITECTURE.md
│   ├── CODEX.md
│   ├── WHATSAPP.md
│   ├── DATA_MODEL.md
│   ├── SECURITY.md
│   └── ROADMAP.md
├── docker-compose.yml
├── pnpm-workspace.yaml
└── package.json
```

Inside `apps/server/src` the modular boundaries are explicit:

```text
core/                      event bus + durable outbox dispatcher
database/                  PostgreSQL pool + migration runner
modules/
├── identity/              households, members, source accounts
├── onboarding/            first household/owner bootstrap
├── auth/                  credentials and persistent sessions
├── security/              visibility and authorization
├── connectors/
│   └── whatsapp/           multi-session runtime, encrypted auth, ingestion
├── ingestion/             provider-neutral source contracts
├── ai/
│   ├── provider.ts         provider-neutral SOL contract
│   └── codex/              App Server, ChatGPT auth and reasoning adapter
├── knowledge/             candidate classification and future knowledge model
├── life/                  chronological source-backed records
├── automation/            schedules/triggers (next)
└── actions/               controlled external writes (next)
ui/                        family, AI and WhatsApp setup UI
```

## Quick start

Requirements: Node.js 22+ (24 recommended), pnpm, Docker, and the Codex CLI available as `codex` if you want the AI engine.

```bash
cp .env.example .env
pnpm install
pnpm db:up
pnpm db:migrate
pnpm dev
```

Then open:

```text
http://127.0.0.1:3000/
```

On first run SOL asks for the household, first owner identity/login and timezone. The bootstrap creates the household, owner credential and a durable `household.bootstrapped` outbox event in one transaction, then starts an authenticated session.

### Connect Codex / ChatGPT

After logging into SOL, open:

```text
http://127.0.0.1:3000/ai
```

From there an owner/adult can start ChatGPT browser OAuth or the device-code fallback. Codex owns and refreshes its OAuth tokens; SOL does not store them in PostgreSQL. SOL uses a separate `.sol/codex` profile so its login does not intentionally reuse the normal Codex CLI/IDE cache.

### Connect WhatsApp

Open:

```text
http://127.0.0.1:3000/whatsapp
```

An authorized member can create one or more WhatsApp source accounts and link each one independently with QR or a pairing code. Personal accounts remain private to the member who owns them; explicitly shared household accounts use family visibility.

SOL stores linked-device auth/Signal keys encrypted in PostgreSQL using a local key under `.sol/secrets/`. QR strings and pairing codes are kept only in runtime memory.

New WhatsApp messages flow through:

```text
Baileys
  ↓
source_items / messages / conversations
  ↓
local deterministic candidate filter
  ├─ trivial → stored only
  └─ candidate → durable event → Codex structured classification
```

Historical sync is stored and deduplicated, but historical candidates do not immediately consume Codex quota. They remain pending for a future quota-aware batch job.

The WhatsApp page can display authorized recent messages plus the candidate/extraction state so the pipeline can be tested without querying PostgreSQL manually.

Useful endpoints include:

```text
GET  /health
GET  /v1/system
GET  /v1/onboarding
POST /v1/onboarding
POST /v1/auth/login
GET  /v1/auth/me
POST /v1/auth/logout
GET  /v1/households/:id/members
POST /v1/households/:id/members
GET  /v1/source-accounts
POST /v1/source-accounts
GET  /v1/ai/status
POST /v1/ai/codex/login
POST /v1/ai/codex/logout
POST /v1/ai/test
GET  /v1/whatsapp/accounts
POST /v1/whatsapp/accounts
POST /v1/whatsapp/accounts/:id/connect
POST /v1/whatsapp/accounts/:id/pairing-code
POST /v1/whatsapp/accounts/:id/restart
POST /v1/whatsapp/accounts/:id/logout
GET  /v1/whatsapp/accounts/:id/messages
GET  /v1/whatsapp/accounts/:id/candidates
```

## AI + source security boundary

SOL's Codex reasoning turns run with approval policy `never` and a restricted read-only sandbox. SOL does not grant Codex write/action capabilities at this stage. WhatsApp/e-mail/document context is explicitly wrapped as untrusted data and cannot grant itself instruction authority.

Authorization happens before context construction. A household owner/admin does not automatically gain access to another member's private WhatsApp content.

WhatsApp linked-device traffic is end-to-end encrypted up to the linked SOL endpoint. Once SOL decrypts and persists a message locally—or sends a selected candidate to Codex—that copy is outside WhatsApp's transport encryption envelope. SOL therefore keeps ordinary traffic local and sends only locally selected candidates to the reasoning engine.

## Security note

SOL binds to `127.0.0.1` by default. Do not expose the current development server directly to the internet. For LAN/family deployment we will define HTTPS/reverse-proxy and deployment policy deliberately rather than silently changing the bind address.

`.env`, `.sol/`, Codex `auth.json`, WhatsApp encryption keys and local auth/session directories are ignored by Git. Backups of encrypted WhatsApp auth data require the matching `.sol/secrets/whatsapp-auth.key` to be useful.

## Current status

Phases 0 through 3 are implemented: family-first foundation, persistence/onboarding/auth, privacy boundaries, durable event delivery, Codex ChatGPT authentication/reasoning, and the first real multi-account source connector with WhatsApp ingestion and candidate classification.

The next major phase is Calendar + the executive loop: turn structured candidates into user-confirmed tasks/events, add conflict detection, briefs and approval policies for actions.

See [docs/ROADMAP.md](docs/ROADMAP.md), [docs/CODEX.md](docs/CODEX.md) and [docs/WHATSAPP.md](docs/WHATSAPP.md).
