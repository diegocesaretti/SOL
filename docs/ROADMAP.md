# SOL roadmap

The order is intentionally dependency-driven rather than feature-driven.

## Phase 0 — Foundation (current)

- [x] Private repository initialized
- [x] TypeScript/pnpm modular-monolith scaffold
- [x] PostgreSQL + pgvector + Redis local infrastructure
- [x] Household/member/source-account data model
- [x] Visibility/access contract
- [x] Provider-neutral ingestion contract
- [x] Provider-neutral AI contract
- [x] Internal event bus primitive
- [x] Provenance/source-link schema
- [x] Action audit schema

## Phase 1 — Persistence + onboarding

- [ ] Add database client and migration runner
- [ ] Repositories/services for household, member and source account
- [ ] First-run household/member onboarding API
- [ ] Authentication/session for SOL UI
- [ ] Unit tests for visibility boundaries
- [ ] Durable event outbox

## Phase 2 — Codex reasoning adapter

- [ ] Implement `CodexProvider` behind `AiProvider`
- [ ] ChatGPT OAuth/App Server login flow
- [ ] Connection/status endpoint
- [ ] Rate-limit/availability awareness
- [ ] Structured reasoning jobs (classification/consolidation/planning)

## Phase 3 — First source: WhatsApp

- [ ] Multi-session connector manager
- [ ] One `source_account` per WhatsApp session
- [ ] Realtime message ingestion
- [ ] History/reconciliation strategy
- [ ] Conversation/identity resolution
- [ ] Zero-AI deterministic filtering for trivial messages
- [ ] Candidate commitment/task extraction

## Phase 4 — Calendar + executive loop

- [ ] Google account/Calendar connector
- [ ] Family and personal calendar mapping
- [ ] Candidate → confirmed event workflow
- [ ] Morning brief
- [ ] Daily consolidation
- [ ] Conflict detection
- [ ] Reminder/action policies

## Phase 5 — Family UI

- [ ] Responsive web/PWA shell
- [ ] Household/member management
- [ ] Per-member source connections
- [ ] Timeline
- [ ] People/projects views
- [ ] Privacy/visibility controls
- [ ] Automations and action approvals

## Later connectors

Gmail, files, Home Assistant, voice/Codex Audio Remote, contacts, Mercado Libre/business sources and other household data can then implement the same source/action contracts without changing SOL Core.
