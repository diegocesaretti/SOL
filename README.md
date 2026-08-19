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
- **Provider independence.** Codex via ChatGPT authentication is the intended first reasoning provider, but SOL's domain must not depend on Codex.
- **Modular monolith first.** Keep deployment simple while preserving module boundaries that can later be extracted if needed.

## Current stack

- Node.js + TypeScript
- PostgreSQL + pgvector
- Redis (reserved for jobs/cache/event coordination)
- Docker Compose for local infrastructure
- Persistent member sessions with `scrypt` password hashing
- Durable event outbox
- Provider-neutral AI interface
- Connectors added incrementally

## Repository layout

```text
SOL/
├── apps/
│   └── server/              # SOL Core HTTP/runtime + first web UI
├── packages/
│   └── database/            # SQL migrations
├── docs/
│   ├── ARCHITECTURE.md
│   ├── DATA_MODEL.md
│   ├── SECURITY.md
│   └── ROADMAP.md
├── docker-compose.yml
├── pnpm-workspace.yaml
└── package.json
```

Inside `apps/server/src` the modular boundaries are explicit:

```text
core/                      event bus and cross-cutting primitives
database/                  PostgreSQL pool + migration runner
modules/
├── identity/              households, members, source accounts
├── onboarding/            first household/owner bootstrap
├── auth/                  credentials and persistent sessions
├── security/              visibility and authorization
├── ingestion/             normalized source events
├── ai/                    provider-neutral reasoning interface
├── life/                  chronological source-backed records (next)
├── knowledge/             facts/entities/relations (next)
├── automation/            schedules/triggers (next)
└── actions/               controlled writes to external systems (next)
ui/                        minimal integrated family UI
```

## Quick start

Requirements: Node.js 22+ (24 recommended), pnpm, Docker.

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

On first run SOL asks for:

- household name
- first owner name
- login name
- password
- timezone (pre-filled from the browser)

The bootstrap creates the household, owner credential and a durable `household.bootstrapped` outbox event in one transaction, then starts an authenticated session.

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
```

## Security note

SOL binds to `127.0.0.1` by default. Do not expose the current development server directly to the internet. For LAN/family deployment we will define HTTPS/reverse-proxy and deployment policy deliberately rather than silently changing the bind address.

Credentials and sessions are never committed to Git. `.env`, Codex `auth.json` and local auth/session directories are ignored.

## Current status

Phase 0 is complete and the core of Phase 1 is implemented: PostgreSQL persistence, explicit migrations, family onboarding, member authentication/session handling, member creation, multi-account source repository/API, visibility tests and durable outbox storage.

The next major integration is the Codex reasoning adapter using ChatGPT/Codex authentication, followed by the first real source connector.

See [docs/ROADMAP.md](docs/ROADMAP.md).
