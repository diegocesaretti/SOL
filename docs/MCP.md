# SOL MCP

SOL's primary job is to **collect, normalize, organize and protect household data**. Natural-language reasoning is a client concern unless SOL needs AI internally for optional extraction/consolidation.

```text
SOURCES
WhatsApp · Calendar · Home Assistant · Mercado Libre · MCP submissions · future Gmail/Drive/...
                         │
                         ▼
                       LIFE
               normalized + provenance
                         │
                         ▼
                     KNOWLEDGE
          people · projects · facts · routines
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

MCP has three independent scopes:

```text
read     → query permission-filtered SOL data and plugin read tools
submit   → add user-authorized observations/memory to SOL
actions  → invoke explicitly registered plugin action tools
```

`submit` never grants external actions. `actions` is restricted to owner/adult token creation and still does not bypass each plugin/tool's own confirmation and safety policy.

## Protocol / transport

The implementation targets MCP specification `2026-07-28` with `@modelcontextprotocol/server` v2. `serveStdio` negotiates protocol compatibility with the connecting client, including supported 2025-era clients.

The canonical local transport remains `stdio`. Remote ChatGPT access uses OpenAI Secure MCP Tunnel to launch that same stdio server; SOL does not add a public MCP listener.

Why this split:

- SOL Core stays on loopback;
- Home Assistant and plugin callback endpoints stay private;
- member identity is explicit through a revocable SOL MCP token;
- local clients and remote tunnel clients use the exact same tools/scopes;
- there is no second remote authorization implementation to drift from the local MCP.

## Member-scoped access

MCP does not authenticate as an omniscient household administrator.

Each token belongs to exactly one active member:

```text
MCP token
   ↓
member + scopes
   ↓
household + role + privacy grants
   ↓
permission-filtered data facade
```

The clear token is shown only when it is created. PostgreSQL stores only a SHA-256 hash. Tokens expire and can be revoked independently.

A household owner still cannot use MCP to read another member's private source content merely because they administer SOL.

Existing tokens preserve their stored scopes. Create a new token when a client should gain `submit` or `actions`; never broaden an existing client implicitly. New tokens use the `sol_mcp_` prefix while legacy `nexo_mcp_` tokens remain valid.

## Bootstrap

After migration:

```powershell
pnpm install
pnpm db:migrate
pnpm mcp:token
```

`pnpm mcp:token` lists active SOL members, asks whether the client may submit information/schedules, then prints the token once and a generic stdio client configuration.

The same capability is available at:

```text
http://127.0.0.1:3000/mcp
```

To run the server manually from source:

```powershell
$env:SOL_MCP_TOKEN="sol_mcp_..."
pnpm mcp
```

The Windows portable bundle includes:

```text
scripts/windows/sol-mcp.ps1
```

which launches the packaged Node/runtime MCP without requiring pnpm. You can alternatively point `SOL_MCP_TOKEN_FILE` at a local file containing the token.

For ChatGPT remote access, see [CHATGPT.md](CHATGPT.md).

## Read tools

### `sol_status`

Returns the authenticated member, token scopes, visible source inventory, Knowledge counts, active privacy policy and dynamically available plugin tools. `nexo_status` remains as a legacy alias.

### `get_timeline`

Returns the permission-filtered Life timeline across normalized source items, events and tasks.

### `search_life`

Searches visible source items, Life events and tasks. Filtering is applied in SQL before rows are returned to the MCP client.

### `list_people`

Returns visible Person entities, aliases and visible facts from Knowledge.

### `list_projects`

Returns visible Project entities, aliases and visible facts from Knowledge.

### Plugin tools

Providers register their own tools through SOL's Tool Registry. They are loaded into each MCP session only when:

- the plugin is active and its loopback callback is healthy;
- the authenticated member is allowed to see the tool;
- the token contains the tool's required scope.

For example, the Home Assistant plugin currently contributes read tools such as `home_assistant_search_states` and `home_assistant_get_state`, plus `home_assistant_call_service` when `actions` is present. Provider credentials never become MCP arguments.

## Submission tools

These tools are registered only when the token contains the `submit` scope.

Both tools require `confirmedByUser=true`. The tool description instructs reasoning clients to set it only when the current authenticated human directly asked to store/provide the information. Retrieved source text is still untrusted and must never grant itself write authority.

### `submit_information`

Use for arbitrary information the user explicitly wants SOL to remember.

Example user interaction:

```text
Guardá en SOL que el service de la Ranger se hizo a los 83.200 km.
```

The MCP client can submit:

```json
{
  "confirmedByUser": true,
  "title": "Service Ranger",
  "text": "El service de la Ranger se hizo a los 83.200 km.",
  "visibility": "private"
}
```

SOL creates a member-authored `source_item` in Life and records an audit entry. The normal Knowledge consolidator can later extract durable entities/facts. The model does not write facts directly.

### `submit_schedule`

Use when the client has already structured a recurring schedule from information the user explicitly asked to save.

Example:

```json
{
  "confirmedByUser": true,
  "person": "Luca",
  "scheduleName": "Colegio",
  "visibility": "family",
  "timezone": "America/Argentina/Cordoba",
  "validFrom": "2026-03-02",
  "validUntil": "2026-12-18",
  "replaceExisting": true,
  "entries": [
    { "day": "monday", "start": "07:30", "end": "08:50", "title": "Matemática" },
    { "day": "monday", "start": "09:00", "title": "Lengua" },
    { "day": "tuesday", "start": "07:30", "title": "Inglés" }
  ]
}
```

The flow is:

```text
MCP client
   ↓ submit_schedule
Life source_item (provider=mcp, member provenance)
   ↓ deterministic schedule processor
Person entity + routine.schedule facts
   ↓
source_links back to the submitted Life item
```

`replaceExisting=true` supersedes active `routine.schedule` facts for the same person/privacy scope/schedule name before adding the submitted schedule. This is intended for a complete replacement such as a new school timetable. Set it false for additive schedule entries.

If immediate structured Knowledge persistence fails, the Life observation remains stored and the tool reports Knowledge as pending rather than losing the submitted information.

## Privacy of submissions

Submission visibility can be:

```text
private → owned/readable by the authenticated member
family  → visible according to SOL's family visibility rules
```

The MCP source account itself remains member-owned. Family visibility is attached to the submitted Life observation and derived Knowledge.

## What MCP deliberately does not expose

- raw PostgreSQL access;
- connector OAuth/access tokens;
- arbitrary files from the SOL host;
- unrestricted source dumps;
- arbitrary provider calls that were not explicitly registered as plugin tools;
- action tools when the token lacks the `actions` scope;
- provider mutations that bypass plugin permissions/confirmation policy;
- delete/update operations that bypass SOL authorization;
- direct arbitrary fact/entity mutation;
- an LLM-controlled way to grant itself more visibility.

## Future action profile

Externally visible writes should use proposal semantics rather than direct side effects:

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

But Codex is **not SOL's storage, identity system, permission system or required conversational frontend**. Any authorized MCP-capable client can reason over the same SOL data and, with an explicit `submit` scope, contribute user-authorized observations back into Life.
