# SOL

SOL is a family-first personal information and automation system: one integrated assistant, many people, many sources, one coherent household knowledge layer.

> **Sources tell SOL what happened → Life records it → Knowledge understands it → SOL decides → Actions execute.**

## Principles

- **Family-first, not single-user.** Every meaningful record belongs to a household and can have an owner, participants and an explicit visibility scope.
- **Multiple accounts per provider.** A member may connect several WhatsApp, Google or other accounts; shared household accounts are also supported.
- **Source traceability.** Derived facts, tasks and memories must be traceable back to the source material that caused them.
- **Privacy before AI.** Authorization filters context before it is sent to an AI provider.
- **One executive brain.** Connectors and deterministic modules collect and structure information; the assistant reasons only when reasoning is useful.
- **Provider independence.** Codex via ChatGPT authentication is the intended first reasoning provider, but SOL's domain must not depend on Codex.
- **Modular monolith first.** Keep deployment simple while preserving module boundaries that can later be extracted if needed.

## Initial stack

- Node.js + TypeScript
- PostgreSQL + pgvector
- Redis (reserved for jobs/cache/event coordination)
- Docker Compose for local infrastructure
- Provider-neutral AI interface
- Connectors added incrementally

## Repository layout

```text
SOL/
├── apps/
│   └── server/              # SOL Core HTTP/runtime process
├── packages/
│   └── database/            # SQL migrations and persistence docs
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
modules/
├── identity/              households, members, source accounts
├── security/              visibility and authorization
├── ingestion/             normalized source events
├── ai/                    provider-neutral reasoning interface
├── life/                  chronological source-backed records (next)
├── knowledge/             facts/entities/relations (next)
├── automation/            schedules/triggers (next)
└── actions/               controlled writes to external systems (next)
```

## Quick start

Requirements: Node.js 22+ (24 recommended), pnpm, Docker.

```bash
cp .env.example .env
pnpm install
pnpm db:up
pnpm dev
```

Then open:

```text
http://localhost:3000/health
```

Expected response:

```json
{"ok":true,"service":"sol-core"}
```

## Current status

This first foundation intentionally does **not** connect WhatsApp, Google or Codex yet. It establishes the household-first identity/privacy model and persistence contract those connectors must obey. See [docs/ROADMAP.md](docs/ROADMAP.md).
