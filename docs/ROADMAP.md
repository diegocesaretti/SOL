# SOL roadmap

The order is intentionally dependency-driven rather than feature-driven.

## Phase 0 — Foundation ✅

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

## Phase 1 — Persistence + onboarding ✅

- [x] PostgreSQL client and explicit migration runner
- [x] Repositories/services for household, member and source account
- [x] First-run household/member onboarding API + UI
- [x] Persistent member authentication/session for SOL UI
- [x] Additional household-member creation with role policy
- [x] Multi-account source-account API with personal/shared ownership
- [x] Unit tests for core visibility boundaries
- [x] Durable event outbox storage and transactional writes
- [x] Localhost-first pre-deployment security default

## Phase 2 — Codex reasoning adapter ✅

- [x] Implement `CodexProvider` behind `AiProvider`
- [x] Codex App Server JSON-RPC/JSONL runtime
- [x] ChatGPT OAuth browser login flow
- [x] ChatGPT device-code fallback
- [x] Connection/status/logout endpoints
- [x] ChatGPT plan + rate-limit awareness
- [x] Integrated `/ai` setup and reasoning-test UI
- [x] Structured reasoning purposes (conversation/classification/consolidation/planning/automation)
- [x] Prompt-injection boundary for source context before Codex
- [x] Outbox dispatcher into SOL's runtime event bus

### Phase 2 follow-ups

- [ ] Decide whether background/batch reasoning should use Codex SDK while interactive auth remains on App Server
- [ ] Persist optional per-household AI profiles if SOL later supports more than one ChatGPT/Codex identity on the same host
- [ ] Add integration tests against a real installed Codex CLI/App Server runtime

## Phase 3 — First source: WhatsApp (next)

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
- [ ] Full household/member management
- [ ] Per-member source connection screens
- [ ] Timeline
- [ ] People/projects views
- [ ] Privacy/visibility controls
- [ ] Automations and action approvals

## Deployment hardening

Before SOL is intentionally exposed beyond localhost:

- [ ] HTTPS/reverse-proxy deployment profile
- [ ] Login throttling / abuse controls
- [ ] Session/device management UI
- [ ] Backup/restore strategy
- [ ] Secret-store integration

## Later connectors

Gmail, files, Home Assistant, voice/Codex Audio Remote, contacts, Mercado Libre/business sources and other household data can then implement the same source/action contracts without changing SOL Core.
