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
- Connectors added incrementally

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
├── ingestion/             normalized source events
├── ai/
│   ├── provider.ts         provider-neutral SOL contract
│   └── codex/              App Server, ChatGPT auth and reasoning adapter
├── life/                  chronological source-backed records (next)
├── knowledge/             facts/entities/relations (next)
├── automation/            schedules/triggers (next)
└── actions/               controlled writes to external systems (next)
ui/                        integrated family + AI setup UI
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

The same screen shows account/plan state, ChatGPT Codex rate-limit usage, and a minimal reasoning test using only the authenticated SOL member and household context.

Useful endpoints:

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
```

## AI security boundary

SOL's Codex reasoning turns run with approval policy `never` and a restricted read-only sandbox. SOL does not grant Codex write/action capabilities at this stage. Source context is explicitly wrapped as untrusted data so future WhatsApp/e-mail/document content cannot grant itself instruction authority.

This is defense in depth: member/household authorization must filter records **before** they become AI context.

## Security note

SOL binds to `127.0.0.1` by default. Do not expose the current development server directly to the internet. For LAN/family deployment we will define HTTPS/reverse-proxy and deployment policy deliberately rather than silently changing the bind address.

`.env`, `.sol/`, Codex `auth.json`, and local auth/session directories are ignored by Git. File-based Codex OAuth credentials must still be treated like passwords.

## Current status

Phases 0, 1 and 2 are implemented: family-first foundation, persistence/onboarding/auth, multi-account source records, privacy boundaries, durable event delivery, Codex App Server integration, ChatGPT OAuth/device login, rate-limit status and restricted reasoning.

The next major integration is the first real source connector: multi-session WhatsApp ingestion.

See [docs/ROADMAP.md](docs/ROADMAP.md) and [docs/CODEX.md](docs/CODEX.md).
