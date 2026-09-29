# ChatGPT ↔ SOL

SOL can be used as a private MCP backend for ChatGPT without exposing SOL Core or Home Assistant directly to the Internet.

## Architecture

```text
ChatGPT / Voice-capable surface
        │
        │ OpenAI Secure MCP Tunnel
        ▼
tunnel-client on the SOL PC
        │
        │ local stdio
        ▼
scripts/windows/sol-mcp.ps1
        │
        ▼
SOL MCP
        │
        ├─ Life / Memory / Knowledge
        └─ Plugin Tool Registry
              ├─ Home Assistant
              ├─ Nexo / WhatsApp
              └─ future SOL plugins
```

The tunnel is outbound-only. SOL remains on loopback and no Home Assistant credential is given to ChatGPT.

## 1. Create a member-scoped SOL MCP token

Open:

```text
http://127.0.0.1:3000/mcp
```

Create an access named `ChatGPT · SOL`.

Scopes:

- `read`: always present; allows visible SOL data and plugin read tools.
- `submit`: optional; allows user-confirmed Life/memory submissions.
- `actions`: optional and restricted to owner/adult; allows plugin action tools such as Home Assistant service calls.

For a first Home Assistant test, use `read` only. Add `actions` only when voice/control actions are intentionally required.

SOL stores only the token hash. Copy the clear token when it is created.

## 2. Verify the local bridge

From the SOL folder:

```powershell
$env:SOL_MCP_TOKEN="sol_mcp_..."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\sol-mcp.ps1
```

The packaged Windows build uses its bundled Node runtime. A source checkout falls back to `pnpm mcp`.

The launcher also accepts `SOL_MCP_TOKEN_FILE`. Legacy `NEXO_MCP_TOKEN*` variables remain compatible.

## 3. Connect Secure MCP Tunnel

Create a Secure MCP Tunnel in the OpenAI Platform and install/run the official `tunnel-client` on the SOL PC.

The SOL MCP page generates the current profile-based command shape:

```powershell
$env:CONTROL_PLANE_API_KEY="<OPENAI_PLATFORM_API_KEY>"
$env:SOL_MCP_TOKEN="sol_mcp_..."

tunnel-client init --sample sample_mcp_stdio_local --profile sol-chatgpt --tunnel-id "<TUNNEL_ID>" --mcp-command "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"C:\path\to\SOL\scripts\windows\sol-mcp.ps1`""
tunnel-client doctor --profile sol-chatgpt --explain
tunnel-client run --profile sol-chatgpt
```

Create the tunnel and obtain the control-plane API key from OpenAI Platform tunnel settings. Keep `tunnel-client run --profile sol-chatgpt` healthy while ChatGPT uses the connection.

Do not publish port 3000 and do not point the tunnel at Home Assistant directly.

## 4. Add SOL in ChatGPT

Where the ChatGPT account/surface supports custom MCP apps/tunnels, add the created tunnel as an app named `SOL`.

ChatGPT Voice can use plugins/apps that are available to the current account, but a private custom MCP is still subject to the account's custom-MCP entitlement. SOL does not bypass those product permissions. For consumer accounts where private custom MCP is unavailable, this bridge remains usable by local MCP clients and by supported OpenAI products until the ChatGPT entitlement changes.

## Home Assistant behavior

The Home Assistant plugin already registers these MCP tools dynamically:

- `home_assistant_cache_status`
- `home_assistant_get_state`
- `home_assistant_search_states`
- `home_assistant_list_people`
- `home_assistant_list_areas`
- `home_assistant_get_services`
- `home_assistant_call_service` when the token has `actions`
- TV/Stremio tools when configured

Example read flow:

```text
"¿Qué temperatura hay en la cocina?"
        ↓
home_assistant_search_states("cocina")
        ↓
home_assistant_get_state(sensor selected)
        ↓
spoken/text response
```

Example action flow:

```text
"Poné el aire de la cocina a 23 grados."
        ↓
home_assistant_search_states(...)
        ↓
home_assistant_call_service(
  confirmedByUser=true,
  domain="climate",
  service="set_temperature",
  ...
)
```

The action tool is not visible without the `actions` scope, and the Home Assistant plugin can still disable control independently.

## Security invariants

- one SOL MCP token maps to one member;
- privacy filtering happens before data reaches the MCP client;
- plugins keep provider credentials;
- plugin callbacks remain loopback-only;
- retrieved external content cannot grant itself write authority;
- memory writes require explicit current-human confirmation;
- Home Assistant service calls require the action scope and tool-level confirmation;
- tokens expire and can be revoked in SOL.

## Compatibility

Existing clients using `nexo_mcp_*`, `NEXO_MCP_TOKEN*` or the legacy `nexo_status` tool keep working. New access uses `sol_mcp_*`, `SOL_MCP_TOKEN*` and `sol_status`.
