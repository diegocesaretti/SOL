# SOL roadmap

SOL's direction is now **data/knowledge first**:

> Sources → Life → Knowledge → Identity/Privacy → MCP → reasoning clients

Executive remains the protected write/action boundary. Codex remains an optional enrichment provider rather than the required frontend/brain.

## Foundation ✅

- [x] Family-first modular monolith
- [x] PostgreSQL/Neon persistence
- [x] Native Windows profile; no Docker/WSL/Hyper-V requirement
- [x] Household/member identity and conservative privacy model
- [x] Multiple personal/shared source accounts
- [x] Provenance/source-link model
- [x] Durable event outbox + PostgreSQL NOTIFY wakeups
- [x] Action audit schema
- [x] Redis and pgvector deferred until measured need

## Sources / Life ✅ core

### WhatsApp

- [x] Multi-session linked-device connector
- [x] Encrypted Baileys credentials
- [x] Realtime + history ingestion
- [x] Personal/shared privacy
- [x] Local relevance gate
- [x] Optional AI candidate classification with deferred recovery when AI is unavailable
- [x] Connection diagnostics UI
- [ ] Real target-host integration/tuning
- [ ] Rich media transcription/extraction
- [ ] More complete contact/LID/entity reconciliation

### Google Calendar

- [x] Multiple OAuth accounts/calendars
- [x] Separate read/write selection
- [x] Incremental reconciliation
- [x] Calendar events represented in Life
- [x] Approved proposal → idempotent Calendar write
- [ ] Real target-host OAuth integration test

### Home Assistant

- [x] Encrypted Long-Lived Access Token
- [x] Entity discovery/current-state reconciliation
- [x] Explicit entity selection
- [x] Snapshot vs changes modes
- [x] Realtime selected `state_changed`
- [x] Selected state exposed through MCP read facade
- [ ] Per-member sensitive entity visibility
- [ ] Audited control actions behind explicit grants/proposals

### Mercado Libre

- [x] OAuth/PKCE model + encrypted rotating credentials
- [x] Int64-safe IDs
- [x] Publications snapshot
- [x] Recent orders/questions
- [x] Business dashboard/context
- [x] Business summary exposed through MCP
- [ ] Real OAuth/API integration test
- [ ] HTTPS webhooks/notifications
- [ ] Historical import
- [ ] Explicit audited business write proposals

## Life + Knowledge 🟡 priority

- [x] Privacy-filtered Life timeline
- [x] People/Projects views
- [x] WhatsApp identity → Person promotion
- [x] Manual Person/Project creation
- [x] Facts/aliases read model
- [x] Incremental privacy-scoped Life → Knowledge consolidator core
- [x] Evidence-ID validation + `source_links` provenance for automatic entities/facts
- [x] Sparse/bounded AI enrichment that skips cleanly when Codex is unavailable
- [x] Manual `pnpm knowledge:consolidate` test/debug command
- [x] First deterministic structured consolidator: MCP recurring schedules → `routine.schedule`
- [x] Complete schedule replacement can supersede prior facts by person/scope/schedule name
- [ ] More deterministic provider-specific structured consolidators that require no AI
- [ ] Entity/alias merge and reconciliation beyond exact conservative matching
- [ ] First-class routine/schedule query API (school/work/activities)
- [ ] Facts/relations with provenance drill-down
- [ ] General Knowledge conflict/supersession model beyond schedules
- [ ] Structured import/review UI for recurring schedules
- [ ] Explicit shared/project grant propagation during consolidation
- [ ] Optional semantic retrieval profile after baseline search is proven

The first AI consolidator intentionally handles only `private` and `family` text-bearing source items. MCP schedule submissions bypass AI for structured normalization, but still enter Life first and retain `source_links` provenance. See `docs/KNOWLEDGE.md` and `docs/MCP.md`.

## MCP ✅ v0.9 core

- [x] MCP specification `2026-07-28` target
- [x] TypeScript MCP SDK v2
- [x] Local stdio transport with modern/legacy negotiation through `serveStdio`
- [x] Member-scoped revocable/expiring tokens
- [x] Independent `read` and `submit` scopes
- [x] Clear token shown once; SHA-256 hash only in PostgreSQL
- [x] Local token bootstrap command
- [x] `sol_status`
- [x] `get_timeline`
- [x] `search_life`
- [x] `list_people`
- [x] `list_projects`
- [x] `get_home_state`
- [x] `get_business_summary`
- [x] `submit_information` → provenance-bearing Life observation
- [x] `submit_schedule` → Life + deterministic schedule Knowledge
- [x] Submission tools require an explicit `submit` token scope
- [x] No raw SQL/connector secrets/direct dangerous actions
- [x] MCP access-management page wired into Web navigation
- [ ] Add MCP resources for stable canonical entities/projects
- [ ] Better date/range filters for Life
- [ ] Source/provenance drill-down tools
- [ ] First-class calendar/schedule read tools
- [ ] Remote MCP over hardened HTTPS authorization
- [ ] Client compatibility tests (Codex/ChatGPT/other MCP hosts)

See `docs/MCP.md`.

## Executive / actions ✅ core, narrower role

Executive is no longer the mandatory conversational brain. It remains the policy boundary for externally visible writes.

- [x] Pending proposals
- [x] Explicit approve/reject
- [x] Private/family decision policy
- [x] Approved local task creation
- [x] Approved Calendar write
- [x] Action audit
- [x] Conflict/brief primitives
- [ ] Proposal editing/clarification
- [ ] Rich reminder/snooze/reschedule policy
- [ ] MCP proposal-oriented action tools
- [ ] HA action grants + stronger security-domain approval
- [ ] Mercado Libre externally visible action policy

Future external-action MCP flow:

```text
client → propose_action → Executive → permission/risk/approval → action → action_log
```

MCP `submit_information` / `submit_schedule` are not external actions: they are authenticated information ingress into Life, with provenance and separate scope control.

## AI providers 🟡 optional enrichment

### Codex adapter ✅

- [x] Provider-neutral `AiProvider`
- [x] Codex App Server
- [x] ChatGPT OAuth/device-code flows
- [x] Restricted reasoning policy
- [x] Source prompt-injection boundary
- [x] Missing/disconnected Codex no longer needs to keep realtime WhatsApp candidate outbox work hot

### New role

AI is optional for:

- extraction from unstructured messages/documents;
- entity/fact discovery;
- Life → Knowledge consolidation;
- alias/relation resolution;
- summaries.

AI is not required for:

- database access;
- MCP Life/Knowledge queries;
- structured MCP schedule ingestion;
- identity/privacy enforcement;
- source ingestion;
- authorization.

## Interfaces

### Web 🟡

- [x] onboarding/auth
- [x] Life + People + Projects
- [x] connector setup pages
- [x] Executive
- [x] MCP token/access UI wired into navigation
- [x] MCP `submit` scope opt-in shown during token creation
- [ ] unified PWA shell/navigation
- [ ] user-facing privacy/grant controls
- [ ] member lifecycle management

### SOL WhatsApp ✅ core

- [x] Dedicated assistant account role
- [x] Member binding by one-time challenge and actual JID/LID
- [x] Permission-filtered questions
- [x] Proposal delivery/approval
- [x] Brief delivery
- [ ] Rebase conversational reads on the same MCP/data facade
- [ ] Rich media/voice
- [ ] multi-turn clarification

### Voice / clients

- [ ] Codex Audio Remote / voice adapter
- [ ] Generic MCP-host compatibility recipes
- [ ] Mobile/PWA interaction improvements

## Next sources

Priority is determined by how much useful family context they add:

1. [ ] Gmail
2. [ ] Google Drive/files
3. [ ] Contacts
4. [ ] richer local files/media
5. [ ] additional business/household sources

## Deployment hardening

- [ ] Windows service/installer
- [ ] automated Neon/PostgreSQL backup + restore
- [ ] backup of host-local encryption keys
- [ ] HTTPS/reverse proxy profile
- [ ] login throttling/session-device controls
- [ ] secret-store integration
- [ ] remote MCP authorization profile
- [ ] revisit pgvector only when semantic retrieval is implemented
- [ ] revisit Redis only if measured queue/cache needs justify it

## Immediate development order

1. Validate MCP read + `submit` tools end-to-end on the target Windows/Codex host.
2. Add first-class schedule/routine read tools (school schedules are the first concrete case).
3. Expand MCP provenance/date-range reads.
4. Add more deterministic structured consolidation where AI is unnecessary.
5. Add Gmail/Drive/Contacts ingestion.
6. Only then expose proposal-oriented MCP external-action tools.
