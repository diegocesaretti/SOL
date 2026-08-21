# Nexo

Nexo is a family-first **WhatsApp + memory/context layer for Codex**.

> **Codex is the assistant. Nexo remembers, protects and exposes context.**

The repository is still named `SOL` for now and several internal package/table identifiers retain the old name during the prototype. The product boundary has changed deliberately: Nexo should not become another competing assistant brain.

## Prototype architecture

```text
                          Codex / “Sol”
                               │
              ┌────────────────┼────────────────┐
              │                │                │
           Gmail           Calendar       Home Assistant MCP
          (direct)          (direct)            (direct)
              │                │                │
              └────────────────┼────────────────┘
                               │
                           Nexo MCP
                               │
                     ┌─────────┴─────────┐
                     │                   │
                  WhatsApp             Memory
              history + realtime   Life + Knowledge
                     │            identity + privacy
                     └─────────┬─────────┘
                               │
                         PostgreSQL
```

Nexo owns:

- observed WhatsApp history and realtime messages;
- Life/provenance;
- durable People/Projects/facts;
- household/member identity and privacy;
- deterministic low-cost attention signals;
- the MCP boundary that exposes this safely to Codex.

Codex owns:

- conversation;
- reasoning and planning;
- interpretation of natural language;
- combining Nexo with Gmail, Calendar, Home Assistant and other tools;
- deciding which Nexo tools to call.

## What changed in v0.12 prototype

Normal Nexo mode now leaves the old background connectors dormant:

```text
NEXO_LEGACY_CONNECTORS=false   # default
NEXO_INTERNAL_AUTOMATION=false # default
```

That means Gmail, Google Calendar, Home Assistant and Mercado Libre adapters remain in the repository/database for compatibility and rollback, but they do **not** background-sync by default. Internal LLM classification/consolidation/proactive briefs are also dormant. Existing historical records are preserved.

To temporarily run the pre-pivot background behavior:

```powershell
$env:NEXO_LEGACY_CONNECTORS="true"
$env:NEXO_INTERNAL_AUTOMATION="true"
pnpm dev
```

The dedicated old “WhatsApp de SOL” assistant account is not autostarted in normal Nexo mode. Observed/member WhatsApp accounts still autostart and ingest normally.

## Nexo MCP

`pnpm mcp` now starts the Nexo-first MCP server. The previous MCP entrypoint is preserved temporarily as:

```powershell
pnpm mcp:legacy
```

Create a member-scoped token from the web UI or with:

```powershell
pnpm mcp:token
```

Launch manually:

```powershell
$env:NEXO_MCP_TOKEN="sol_mcp_..."
pnpm mcp
```

`SOL_MCP_TOKEN` still works as a compatibility alias during the prototype.

### Read tools

```text
nexo_status
get_timeline
search_life
search_whatsapp
get_attention_queue
list_people
list_projects
```

`search_whatsapp` is the main missing-data bridge for Codex: it returns permission-filtered message text together with conversation, sender, timestamp and `sourceItemId` provenance.

`get_attention_queue` exposes the cheap deterministic Intelligence Gate. It does **not** tell Codex what a message means; it only returns recent observations that look potentially operational or durable so Codex can inspect them when useful.

### Submit/memory tools

With a token that has the `submit` scope:

```text
save_observation
remember_fact
save_schedule
```

`remember_fact` is intentionally explicit. It stores one user-confirmed durable fact, creates a Life observation first, writes structured Knowledge and preserves optional evidence links to source items. Retrieved WhatsApp/web/email content can be evidence, but cannot by itself authorize a memory write.

No Nexo MCP tool performs Home Assistant actions, sends Gmail, writes Google Calendar or exposes raw SQL/connector credentials.

## Privacy model

- Every MCP token represents one member.
- Private records of another member are filtered before they reach Codex.
- Household owner/admin status is not a universal private-data bypass.
- Family-visible records are shared only within the household scope.
- Source evidence remains linked to derived memory.
- Untrusted message text is data, never an instruction to Nexo.

## Quick start

Requirements: Node.js 22+, pnpm and PostgreSQL/Neon.

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

Primary prototype screens:

```text
/                         Nexo home
/whatsapp?advanced=1      observed WhatsApp accounts
/life                     Life + People + Projects
/mcp                      Codex ↔ Nexo MCP access
```

The older provider-specific routes still exist during the prototype but are no longer part of Nexo's normal navigation.

## Repository compatibility

## Morning Brief

Morning Brief runs once per local day at `08:00` in `America/Argentina/Buenos_Aires`. It reuses the existing Gmail, Google Calendar, Mercado Libre, WhatsApp ingestion, executive brief, proposal and PostgreSQL/outbox architecture. A database uniqueness constraint prevents duplicate daily runs; if Nexo starts later the same day, the scheduler performs the pending run once.

Open `/executive?advanced=1` to enable/disable it, select sources, use **Vista previa** (no Calendar/WhatsApp writes), or **Probar ahora**. Runs and partial source errors are stored in `morning_brief_runs`.

Proactive WhatsApp delivery is independent from interactive `confirmedByUser`. It requires all three controls:

1. `morningWhatsappGrant` enabled in Morning Brief settings;
2. a fixed destination and enabled Morning Brief policy in Whatsapp-Codex-Nexo;
3. the same local `NEXO_AUTOMATION_TOKEN` in both processes.

The destination never comes from Gmail, WhatsApp, Mercado Libre, Calendar or LLM output. Configure the bridge URL with `WHATSAPP_NEXO_URL` (default `http://127.0.0.1:3210`).

On Windows, install the persistent hidden host once with `powershell -ExecutionPolicy Bypass -File scripts/windows/install-nexo-startup.ps1`. It starts at logon, restarts after failures and lets Morning Brief catch up once when the machine starts after 08:00. Use the same command with `-Remove` to uninstall it.

MCP tools: `get_morning_brief_status`, `get_last_morning_brief`, `get_morning_brief_settings`, `run_morning_brief({dryRun})`, and confirmed mutation `configure_morning_brief`.

To minimize migration risk in the first prototype, these old technical identifiers remain temporarily:

```text
repository: diegocesaretti/SOL
package:    @sol/server
DB names:   existing SOL schema
```

Changing those identifiers provides little architectural value right now and would create unnecessary migration risk. If this prototype proves the new boundary, a later cleanup can rename them deliberately.

## Design rule

Before adding a new integration to Nexo, ask:

> **Does Codex already have a good direct connector or MCP for this?**

If yes, Nexo should normally not duplicate it.

Nexo should specialize in information Codex otherwise cannot reliably access or remember—starting with WhatsApp and private/family durable memory.
