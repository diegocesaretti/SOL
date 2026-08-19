# SOL roadmap

The order is intentionally dependency-driven rather than feature-driven.

## Phase 0 — Foundation ✅

- [x] Private repository initialized
- [x] TypeScript/pnpm modular-monolith scaffold
- [x] Standard PostgreSQL-first infrastructure
- [x] Neon-managed PostgreSQL profile with secure local `DATABASE_URL` configuration
- [x] Native Windows PostgreSQL fallback; no Docker/WSL/Hyper-V requirement
- [x] Redis removed until a demonstrated workload requires it
- [x] pgvector deferred to an optional semantic-search migration
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
- [x] Event-driven outbox wakeups through PostgreSQL `NOTIFY`
- [x] Slow outbox recovery reconciliation instead of high-frequency polling
- [x] Small/short-lived database pool for scale-to-zero compatibility
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

## Phase 3 — First source: WhatsApp ✅

- [x] Multi-session connector manager
- [x] One `source_account` per WhatsApp linked-device session
- [x] Encrypted PostgreSQL Baileys auth/Signal-key store
- [x] QR and pairing-code connection UI
- [x] Realtime `messages.upsert` ingestion
- [x] History sync/reconciliation with idempotent message IDs
- [x] Direct/group conversation and basic identity resolution
- [x] Personal vs shared-family privacy boundaries
- [x] Zero-AI deterministic filtering for trivial messages
- [x] Candidate commitment/task/event/deadline detection
- [x] Realtime candidate → Codex structured classification
- [x] Historical candidates held for future quota-aware batch processing
- [x] Automatic reconnect with explicit logout/bad-session handling

### Phase 3 follow-ups

- [ ] Real linked-device integration test on the target SOL host
- [ ] Tune local Spanish candidate heuristics from real household traffic
- [ ] Quota-aware historical candidate consolidation job
- [ ] Rich media pipeline (voice transcription, document/image extraction) with explicit privacy policy
- [ ] More complete LID/contact/entity reconciliation

## Phase 4 — Calendar + executive loop ✅ core

- [x] Google Calendar OAuth connector with offline refresh
- [x] Multiple Google accounts per household/member
- [x] Multiple calendars per account with separate read/write selection
- [x] Family vs personal Calendar privacy mapping
- [x] Incremental Calendar reconciliation with sync tokens and full-resync recovery
- [x] Calendar events represented in Life with provenance
- [x] Candidate → executive proposal workflow
- [x] Explicit approval/rejection boundary before actions
- [x] Approved task → local SOL task
- [x] Approved timed event → idempotent Google Calendar write
- [x] Family proposal decision restricted to owner/adult
- [x] Daily member brief generation
- [x] Tomorrow-preview brief generation
- [x] Schedule-conflict detection
- [x] Persisted briefs reusable by future delivery channels
- [x] Integrated `/calendar` and `/executive` UI
- [x] Sparse Calendar/executive reconciliation defaults for managed scale-to-zero PostgreSQL

### Phase 4 follow-ups

- [ ] Real Google OAuth + Calendar integration test on the target SOL host
- [ ] Daily/nightly Life → Knowledge consolidation pass
- [ ] Quota-aware historical WhatsApp candidate consolidation
- [ ] Rich proposal editing before approval (time/title/destination)
- [ ] Reminder delivery policy and snooze/reschedule model
- [ ] Optional Google Tasks or another external task provider

## Phase 5 — SOL communication channel

- [ ] Give SOL its own dedicated WhatsApp account/session role
- [ ] Treat SOL WhatsApp as an assistant interface/action channel, not an ordinary personal source
- [ ] Resolve incoming sender → authenticated household member
- [ ] Deliver morning/tomorrow briefs through SOL WhatsApp
- [ ] Ask for proposal approvals through SOL WhatsApp
- [ ] Receive natural-language questions/commands through SOL WhatsApp
- [ ] Route approved outbound WhatsApp messages through `action_log`
- [ ] Prevent observed third-party messages from gaining command authority

## Phase 6 — Family UI + knowledge views

- [ ] Responsive web/PWA shell
- [ ] Full household/member management
- [ ] Per-member source connection screens
- [ ] Timeline
- [ ] People/projects views
- [ ] Privacy/visibility controls
- [ ] Automations and action approvals

## Planned first-class connectors

### Home Assistant

- [ ] Entity/device state ingestion
- [ ] Presence, alarms and meaningful state-change events
- [ ] Sensor/energy context where useful
- [ ] Separate read permissions from control permissions
- [ ] Audited actions with stronger approval for risky controls

### Mercado Libre API

- [ ] OAuth/account connector
- [ ] Orders/sales ingestion
- [ ] Questions/messages and listing state
- [ ] Stock/pricing/shipping/payment signals
- [ ] Business-scoped knowledge/projects
- [ ] Explicitly authorized listing/reply/stock/price actions

### Other sources

- [ ] Gmail
- [ ] Google Drive/files
- [ ] Contacts
- [ ] Voice / Codex Audio Remote
- [ ] Additional household/business sources

## Deployment hardening

Before SOL is intentionally exposed beyond localhost:

- [ ] Register SOL Core as an always-on Windows service on the target host
- [ ] Automated PostgreSQL backup/restore workflow for Neon and local profiles
- [ ] HTTPS/reverse-proxy deployment profile
- [ ] Login throttling / abuse controls
- [ ] Session/device management UI
- [ ] Backup/restore strategy including local encryption keys
- [ ] Secret-store integration
- [ ] Revisit optional pgvector only when semantic retrieval is actually implemented
- [ ] Revisit Redis only if measured queue/cache coordination needs justify another service

See `docs/INTEGRATIONS.md` for the distinction between sources, action targets and assistant interfaces.
