# SOL roadmap

SOL's direction is **data/knowledge first**:

> Inputs → Life → Knowledge → Identity/Privacy → MCP → reasoning clients

External effects are separate:

> reasoning client → proposal/policy → Outputs → audited action

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

## Inputs / Life ✅ core

### WhatsApp

- [x] Multi-session linked-device connector
- [x] Encrypted Baileys credentials
- [x] Realtime + history ingestion
- [x] Personal/shared privacy
- [x] Local relevance gate
- [x] Optional AI candidate classification with deferred recovery when AI is unavailable
- [x] Connection diagnostics
- [x] Source health/feed visible from unified Inputs
- [ ] Real target-host integration/tuning
- [ ] Rich media transcription/extraction
- [ ] More complete contact/LID/entity reconciliation

### Gmail

- [x] OAuth Authorization Code + PKCE
- [x] `gmail.readonly` only; no mailbox mutation
- [x] Encrypted refresh/access credentials
- [x] Personal/family source ownership
- [x] Recent bounded mailbox sync + stable message-ID dedupe
- [x] MIME text/plain extraction + HTML fallback
- [x] Email/thread/message/identity mapping into generic SOL models
- [x] Email source items visible immediately in Life
- [x] Sparse scheduled sync + manual sync in Inputs
- [ ] Real Google OAuth/Gmail API integration test on target account
- [ ] Gmail push/watch notifications
- [ ] Full historical import
- [ ] Attachments / document extraction
- [ ] Better quoted-text/signature reduction

See `docs/GMAIL.md`.

### Google Calendar

- [x] Multiple OAuth accounts/calendars
- [x] Read capability represented as Input
- [x] Separate read/write selection
- [x] Incremental reconciliation
- [x] Calendar events represented in Life
- [x] Approved proposal → idempotent Calendar write Output
- [ ] Real target-host OAuth integration test

### Home Assistant

- [x] Encrypted Long-Lived Access Token
- [x] Entity discovery/current-state reconciliation
- [x] Explicit entity selection
- [x] Snapshot vs changes modes
- [x] Realtime selected `state_changed`
- [x] Selected state exposed through MCP read facade
- [x] Read capability surfaced as Input
- [ ] Per-member sensitive entity visibility
- [ ] Audited control Output behind explicit grants/proposals

### Mercado Libre

- [x] OAuth/PKCE model + encrypted rotating credentials
- [x] Int64-safe IDs
- [x] Publications snapshot
- [x] Recent orders/questions
- [x] Business dashboard/context
- [x] Business summary exposed through MCP
- [x] Read capability surfaced as Input
- [ ] Real OAuth/API integration test
- [ ] HTTPS webhooks/notifications
- [ ] Historical import
- [ ] Explicit audited business write Output

## Life + Knowledge 🟡 priority

- [x] Privacy-filtered Life timeline
- [x] People/Projects views
- [x] Provider filters including WhatsApp/Gmail/Calendar/HA/MeLi/MCP
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

The AI consolidator intentionally handles only compatible privacy scopes in each batch. Structured MCP schedules bypass AI but still enter Life first and retain provenance.

## MCP ✅ core

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

## Outputs / actions ✅ core model

The unified Outputs surface now separates what SOL can **do** from what SOL can merely **read**.

### Current

- [x] WhatsApp de SOL as communication Output/interface
- [x] Google Calendar selected write destination
- [x] Executive pending proposals / approve / reject
- [x] Private/family decision policy
- [x] Approved local task creation
- [x] Approved Calendar write
- [x] Action audit
- [x] Conflict/brief primitives
- [x] Home Assistant control shown explicitly as unavailable rather than implied by read access
- [x] Mercado Libre writes shown explicitly as unavailable rather than implied by read access

### Next

- [ ] Proposal editing/clarification
- [ ] Rich reminder/snooze/reschedule policy
- [ ] MCP proposal-oriented action tools
- [ ] HA action grants + stronger security-domain approval
- [ ] Mercado Libre externally visible action policy
- [ ] Future Gmail send Output only with separate OAuth scope/policy; never implied by Gmail Input

Future external-action MCP flow:

```text
client → propose_action → Executive → permission/risk/approval → Output → action_log
```

## AI providers 🟡 optional enrichment

### Codex adapter ✅

- [x] Provider-neutral `AiProvider`
- [x] Codex App Server
- [x] ChatGPT OAuth/device-code flows
- [x] Restricted reasoning policy
- [x] Source prompt-injection boundary
- [x] Missing/disconnected Codex no longer needs to keep realtime WhatsApp candidate outbox work hot

AI is optional for extraction, entity/fact discovery, Life → Knowledge consolidation, alias/relation resolution and summaries. It is not required for source ingestion, database access, privacy enforcement or authorization.

## Interfaces

### Web ✅ v0.10 shell

Primary navigation is intentionally small:

```text
Inicio
Inputs
Outputs
Life
MCP
AI
```

- [x] Unified shell/navigation
- [x] Inputs control center with source health, counters and raw feed
- [x] Outputs control center with capability/status separation
- [x] Legacy provider pages hidden from normal navigation and available only as advanced adapters
- [x] onboarding/auth
- [x] Life + People + Projects
- [x] MCP token/access UI
- [x] Windows notification-tray health indicator
- [ ] Move remaining provider-specific advanced settings fully into Inputs/Outputs dialogs
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

## Next Inputs

1. [ ] Google Drive/files
2. [ ] Contacts
3. [ ] richer local files/media
4. [ ] additional business/household sources

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

1. Validate v0.10 migration `0014_gmail` + Gmail OAuth/sync on the target Windows host.
2. Diagnose/finish WhatsApp target-host ingestion using Inputs raw feed counters.
3. Add first-class schedule/routine MCP reads.
4. Move remaining advanced provider settings into the unified Inputs/Outputs UI.
5. Add Drive/Contacts ingestion.
6. Expand provenance/date-range reads and deterministic structured consolidation.
7. Only then expose more proposal-oriented external Outputs.
