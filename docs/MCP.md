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

MCP now has two independent scopes:

```text
read    → query permission-filtered SOL data
submit  → add user-authorized observations to Life
```

`submit` is deliberately **not** an action/executive scope. It cannot write Calendar, call Home Assistant services, change Mercado Libre, grant permissions or directly mutate arbitrary Knowledge.

## Protocol / transport

The implementation targets MCP specification `2026-07-28` with `@modelcontextprotocol/server` v2. `serveStdio` negotiates protocol compatibility with the connecting client, including supported 2025-era clients. The initial transport is local `stdio`.

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
member + scopes
   ↓
household + role + privacy grants
   ↓
permission-filtered data facade
```

The clear token is shown only when it is created. PostgreSQL stores only a SHA-256 hash. Tokens expire and can be revoked independently.

A household owner still cannot use MCP to read another member's private source content merely because they administer SOL.

Existing tokens created before submission support remain `read` only. Create a new token and explicitly enable submissions when a client such as Codex should be able to save information into SOL.

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

To run the server manually:

```powershell
$env:SOL_MCP_TOKEN="sol_mcp_..."
pnpm mcp
```

You can alternatively point `SOL_MCP_TOKEN_FILE` at a local file containing the token so it does not need to be placed directly in an environment block.

## Read tools

### `sol_status`

Returns the authenticated member, token scopes, visible source inventory, Knowledge counts and the active privacy policy.

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
- `call_service` against Home Assistant;
- direct Mercado Libre stock/price/listing/reply mutations;
- immediate Calendar writes;
- delete/update operations that bypass Executive;
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
