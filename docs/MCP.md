# SOL MCP

SOL's primary job is now to **collect, normalize, organize and protect household data**. Natural-language reasoning is a client concern unless SOL needs AI internally for optional extraction/consolidation.

```text
SOURCES
WhatsApp · Calendar · Home Assistant · Mercado Libre · future Gmail/Drive/...
                         │
                         ▼
                       LIFE
               normalized + provenance
                         │
                         ▼
                     KNOWLEDGE
              people · projects · facts
                         │
                         ▼
                 PRIVACY / IDENTITY
                         │
                         ▼
                        MCP
              ┌──────────┼──────────┐
              ▼          ▼          ▼
            Codex     ChatGPT     other clients
```

## Design rule

**The model thinks; SOL owns data and authorization.**

MCP clients do not receive database credentials, unrestricted SQL, another member's private records, connector secrets or direct dangerous actions.

The first MCP profile is intentionally **read-only**. Executive/action functionality remains inside SOL and can later be exposed only through proposal-oriented tools with explicit policy and audit.

## Protocol / transport

The implementation targets MCP specification `2026-07-28` with `@modelcontextprotocol/server` v2. The initial transport is local `stdio`.

Why stdio first:

- no public HTTP listener;
- no remote OAuth surface yet;
- ideal for a SOL host that also runs a local MCP-capable client;
- member identity is explicit through a revocable SOL MCP token;
- remote MCP can be added later without rewriting the data facade/tools.

## Member-scoped access

MCP does not authenticate as an omniscient household administrator.

Each token belongs to exactly one active member:

```text
MCP token
   ↓
member
   ↓
household + role + privacy grants
   ↓
permission-filtered data facade
```

The clear token is shown only when it is created. PostgreSQL stores only a SHA-256 hash. Tokens expire and can be revoked independently.

A household owner still cannot use MCP to read another member's private source content merely because they administer SOL.

## Bootstrap

After migration:

```powershell
pnpm install
pnpm db:migrate
pnpm mcp:token
```

`pnpm mcp:token` lists active SOL members. Choose the identity the MCP client should represent. The command prints the token once and a generic stdio client configuration.

To run the server manually:

```powershell
$env:SOL_MCP_TOKEN="sol_mcp_..."
pnpm mcp
```

You can alternatively point `SOL_MCP_TOKEN_FILE` at a local file containing the token so it does not need to be placed directly in an environment block.

## Tools: v0.9 read-only profile

### `sol_status`

Returns the authenticated member, visible source inventory, Knowledge counts and the active read/privacy policy.

### `get_timeline`

Returns the permission-filtered Life timeline across normalized source items, events and tasks.

### `search_life`

Searches visible source items, Life events and tasks. Filtering is applied in SQL before rows are returned to the MCP client.

### `list_people`

Returns visible Person entities, aliases and visible facts from Knowledge.

### `list_projects`

Returns visible Project entities, aliases and visible facts from Knowledge.

### `get_home_state`

Returns current Home Assistant entities explicitly selected for SOL sync. This is a read tool; it does not call Home Assistant services.

### `get_business_summary`

Returns the compact permission-filtered Mercado Libre summary already used by SOL's business context. It does not include connector credentials or buyer addresses.

## What MCP deliberately does not expose yet

- raw PostgreSQL access;
- connector OAuth/access tokens;
- arbitrary files from the SOL host;
- unrestricted source dumps;
- `call_service` against Home Assistant;
- direct Mercado Libre stock/price/listing/reply mutations;
- immediate Calendar writes;
- delete/update operations that bypass Executive;
- an LLM-controlled way to grant itself more visibility.

## Future write profile

Writes should use proposal semantics rather than direct side effects:

```text
MCP client
   ↓
propose_action(...)
   ↓
SOL Executive
   ↓
identity + permission + risk policy
   ↓
explicit approval when required
   ↓
action target
   ↓
action_log
```

Potential later tools:

- `propose_calendar_event`
- `propose_task`
- `propose_home_action`
- `propose_business_action`
- `get_proposal`
- `approve_proposal` only when the client/user identity and policy allow it

Security-sensitive operations such as locks, alarms and externally visible business changes remain higher-risk actions even when exposed through MCP.

## Codex after this architectural change

Codex remains useful inside SOL for jobs such as:

- classifying a promising WhatsApp message;
- extracting entities/facts from unstructured text;
- consolidating many Life records into Knowledge;
- resolving aliases/relationships;
- generating optional summaries.

But Codex is **not SOL's storage, identity system, permission system or required conversational frontend**. Any authorized MCP-capable client can reason over the same SOL data.
