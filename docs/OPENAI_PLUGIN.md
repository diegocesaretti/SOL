# SOL public plugin for ChatGPT

SOL 0.15.23 includes a public-plugin path alongside the existing local MCP and Secure MCP Tunnel path.

## Architecture

```text
ChatGPT / Voice
      |
      | OAuth 2.1 + Streamable HTTP MCP
      v
Public SOL Plugin Gateway (HTTPS)
      |
      | queued request/response relay
      v
SOL OpenAI Bridge on the user's PC
      |
      | local stdio MCP
      v
SOL Tool Registry
      |
      +-- Home Assistant
      +-- Memory / Life
      +-- Nexo / WhatsApp
      +-- future SOL plugins
```

The home network accepts no inbound connection. The local bridge polls the public gateway over HTTPS and invokes the existing member-scoped SOL MCP.

## Gateway deployment

The monorepo includes `render.yaml` and the deployable package `apps/plugin-gateway`.

Required production environment:

- `SOL_GATEWAY_SIGNING_SECRET`: at least 32 random bytes. Render blueprint generates this.
- `SOL_GATEWAY_PUBLIC_ORIGIN`: optional on Render; otherwise set to the exact HTTPS origin.
- `OPENAI_APPS_CHALLENGE`: set to the exact domain-verification token supplied by the OpenAI plugin portal.
- `SOL_GATEWAY_SUPPORT_EMAIL`: optional public support contact.

The production service exposes:

- `/mcp`: Streamable HTTP MCP.
- `/.well-known/oauth-protected-resource`: RFC 9728 resource metadata.
- `/.well-known/oauth-authorization-server`: OAuth authorization-server metadata.
- `/oauth/register`: dynamic client registration.
- `/oauth/authorize`: authorization-code + PKCE login/pairing flow.
- `/oauth/token`: access/refresh tokens.
- `/.well-known/openai-apps-challenge`: OpenAI domain verification.
- `/privacy`, `/terms`, `/support`: listing/review URLs.
- `/health`: deployment health check.

## Local bridge

Create a SOL MCP token from **SOL → MCP** with the scopes you want ChatGPT to be able to use. For full Home Assistant + SOL behavior, create it with:

```text
read + submit + actions
```

Then configure the Windows SOL environment:

```dotenv
SOL_OPENAI_GATEWAY_URL=https://<gateway-host>
SOL_OPENAI_BRIDGE_SCOPES=read,submit,actions
SOL_MCP_TOKEN_FILE=C:\secure\sol-chatgpt-token.txt
```

Start:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\sol-openai-bridge.ps1
```

The portable Windows bundle contains this script. It starts the local MCP as a child process, lists its real tools and mirrors only those tools to the gateway.

Bridge state is stored under:

```text
SOL_DATA_DIR/openai-plugin-bridge.json
```

The file contains the gateway bridge credential and is written with restricted permissions where the OS supports them. Do not publish or sync this file.

SOL exposes the redacted state at:

```text
GET /v1/mcp/openai-bridge/status
```

## Pairing

The bridge periodically obtains a short-lived pairing code such as:

```text
ABCD-EFGH
```

During ChatGPT OAuth linking, the public authorization page asks for this code. No SOL password, Home Assistant token or MCP token is sent through the browser.

After the code is accepted, the gateway issues an OAuth access token bound to that SOL instance. OAuth scopes map directly onto SOL scopes:

- `sol.read` → `read`
- `sol.submit` → `submit`
- `sol.actions` → `actions`

The local SOL MCP remains the final authorization boundary. The public gateway cannot create a tool that the local member-scoped MCP did not advertise.

## Plugin package

`openai-plugin/` contains:

- `plugin.json`: portable Agent Plugins manifest.
- `mcp.json`: remote MCP declaration.
- `skills/sol-home/SKILL.md`: instructions for live-state verification and safe Home Assistant usage.

If deployment receives a hostname other than `sol-plugin-gateway.onrender.com`, update the URLs in `openai-plugin/plugin.json` and `openai-plugin/mcp.json` before submission.

## OpenAI submission

Use **Create plugin → With MCP** and submit the deployed `https://<gateway>/mcp` endpoint. The portal scans tools directly from the server. Complete publisher identity, listing copy, demo/reviewer pairing instructions, country availability and policy attestations in the portal.

For domain verification, copy the portal challenge into `OPENAI_APPS_CHALLENGE` and redeploy. The challenge route returns the token as plain text.

## Security model

- Home Assistant and provider credentials never leave SOL.
- SOL does not accept an inbound Internet connection.
- Pair codes expire and are single-use.
- OAuth authorization uses PKCE S256.
- Access and refresh tokens are signed by the gateway and expire.
- Each OAuth token is bound to exactly one bridge instance.
- The bridge itself is bound to the SOL MCP token used to launch it.
- Action tools remain unavailable unless both the local SOL MCP token and OAuth grant allow actions.
- Existing tool-level confirmation fields remain enforced by the local plugin.
- External content retrieved through SOL cannot grant itself write permission.

The gateway currently keeps active catalogs, transient pair codes and in-flight jobs in process memory. Signed bridge/OAuth credentials remain valid across a gateway restart, and the local bridge republishes its catalog automatically. An in-flight tool call can fail during a gateway restart and should be retried by the client.
