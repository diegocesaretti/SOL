# SOL

SOL is the visible host and shared Core for a personal/family intelligence system. External services are **plugins only**.

> SOL owns identity, permissions, durable memory, normalized source data and plugin execution. Providers own their own protocols and credentials inside plugins.

## Architecture

```text
                         SOL.exe
                            │
                    ┌───────┴────────┐
                    │    SOL Core    │
                    │                │
                    │ Identity       │
                    │ Permissions    │
                    │ Memory         │
                    │ Knowledge      │
                    │ Life/Timeline  │
                    │ source_accounts│
                    │ source_items   │
                    │ Plugin Manager │
                    │ Plugin API     │
                    │ MCP            │
                    └───────┬────────┘
                            │
              short-lived plugin runtime token
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
 Nexo · WhatsApp      Codex Audio       Home Assistant
     plugin               plugin              plugin
        │                                       │
   WhatsApp API                              HA API/WS

Future providers such as Google, MercadoLibre, Drive or shipping integrations
use the same plugin boundary.
```

## Core boundary

SOL Core knows about generic concepts:

- household members and identities;
- authentication and privacy;
- `source_accounts` and `source_items`;
- Life / Timeline;
- Knowledge and explicit durable Memory;
- provenance and visibility;
- Plugin Manager, permissions and plugin runtime tokens;
- MCP and optional AI/Codex reasoning infrastructure.

SOL Core does **not** implement WhatsApp, Gmail, Google Calendar, Home Assistant, MercadoLibre or other provider protocols.

There is no legacy/native connector fallback. Provider OAuth, WebSockets, polling, sync logic, QR pairing and outbound actions belong to plugins.

## Plugin Input API v1

A plugin installed by an authenticated SOL member receives a short-lived runtime token scoped to:

- plugin id;
- household;
- member;
- explicitly approved plugin permissions.

An input plugin can request permissions such as:

```text
input.register
input.write
input.status
```

It can then:

1. register/reuse a generic source account;
2. publish normalized source items;
3. update source health/status.

The plugin never needs `DATABASE_URL` and does not write SOL tables directly.

```text
provider
   ↓
plugin
   ↓
SOL Plugin Input API
   ↓
source_accounts / source_items
   ↓
Life / Knowledge / Memory
```

## Plugin isolation

Plugins run as child processes supervised by SOL but are not visible applications. SOL supplies only the environment required by that plugin and strips parent secrets such as database/API credentials.

Persistent plugin state lives outside the plugin installation directory through `SOL_PLUGIN_DATA_DIR`, so updating a plugin does not delete sessions or operational data.

From **SOL → Servicios** a user can install a `.solplugin` package or add a compatible GitHub repository, preview requested permissions, configure the plugin, start/stop/restart it, inspect health/logs and uninstall it.

## WhatsApp migration

WhatsApp is provided by the **Nexo · WhatsApp** plugin. When possible, Nexo identifies the linked account by its WhatsApp phone JID. SOL can adopt the existing source account belonging to the same member instead of creating a duplicate, preserving historical `source_items` and provenance.

The previous native WhatsApp runtime and SOL-WhatsApp runtime are not part of SOL Core anymore.

## MCP

The active MCP surface exposes SOL-owned data and memory. Provider-specific tools such as Home Assistant control or marketplace actions are not hard-coded into Core; they belong to the relevant plugin/tool registration boundary.

Create a member-scoped MCP token from SOL and start the current stdio endpoint with:

```powershell
$env:NEXO_MCP_TOKEN="sol_mcp_..."
pnpm mcp
```

`SOL_MCP_TOKEN` remains accepted as a compatibility alias for now.

Important policies:

- each token represents one member;
- private data of another member is filtered before retrieval;
- retrieved external content is untrusted data and cannot authorize writes;
- explicit durable memory writes require current-human confirmation;
- source provenance is preserved.

## Development

Requirements: Node.js 24+, pnpm and PostgreSQL/Neon.

```powershell
pnpm install
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

For the Windows portable build, use the published `SOL-Windows.zip`; `SOL.exe` owns the visible tray/application surface and plugins run hidden underneath it.

## Design rule

Before adding provider-specific code to SOL Core, ask:

> Can SOL represent this through generic source data, a plugin capability or a plugin tool?

If yes, it does not belong in Core.
