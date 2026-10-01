# SOL Fast local bridge

SOL Fast is the low-latency local bridge used by ChatGPT Voice through Remote Desktop Commander on the household HTPC.

## Architecture

```
ChatGPT / Voice
  -> Remote Desktop Commander
  -> C:\sol\sol-fast.cmd   (fast path for common commands)
     or C:\sol\sol-fast.ps1 (discovery / complex raw calls)
  -> http://127.0.0.1:8770
  -> SOL Fast persistent MCP clients
       - SOL Core MCP
       - Nexo / WhatsApp MCP
  -> Home Assistant, Stremio, memory, WhatsApp and the rest of the exposed SOL tools
```

The server merges provider catalogs by tool name and exposes one self-describing surface. At runtime the number of tools is dynamic.

## Discovery

```powershell
C:\sol\sol-fast.ps1
C:\sol\sol-fast.ps1 help
C:\sol\sol-fast.ps1 tools
C:\sol\sol-fast.ps1 schema home_assistant_call_service
```

Unknown quick commands return machine-readable guidance so an agent can recover by using `tools`, `schema` and `call`.

## Fast path

For common HTPC operations prefer the CMD client because starting a fresh PowerShell process adds substantial latency:

```cmd
C:\sol\sol-fast.cmd tv_cocina
C:\sol\sol-fast.cmd tv_dormitorio
C:\sol\sol-fast.cmd aire_cocina
C:\sol\sol-fast.cmd youtube_play "dQw4w9WgXcQ" dormitorio
```

The PowerShell wrapper remains the compatible full client for discovery and complex/raw calls.

## Quick commands

Examples:

```powershell
C:\sol\sol-fast.ps1 tv_cocina
C:\sol\sol-fast.ps1 tv_dormitorio
C:\sol\sol-fast.ps1 aire_cocina
C:\sol\sol-fast.ps1 home_find "tele cocina"
C:\sol\sol-fast.ps1 media_play "Los Simpson"
C:\sol\sol-fast.ps1 youtube_play "https://www.youtube.com/watch?v=..."
C:\sol\sol-fast.ps1 whatsapp_search "texto"
C:\sol\sol-fast.ps1 memory_search "texto"
C:\sol\sol-fast.ps1 context_search "texto"
```

Any raw MCP tool can be called with:

```powershell
C:\sol\sol-fast.ps1 call <tool_name> '<json arguments>'
```

## Action safety

Real-world actions require an explicit current-user request. SOL Fast preserves the confirmation requirement of the underlying tools. The `home_action` and `youtube_play` quick commands only add `confirmedByUser=true` when invoked through the action path.

For ordinary actions the calling agent should verify live state before claiming success. `youtube_play` is optimized specially: it performs action + verification inside the same SOL Fast request, so the caller should not issue a second verification round trip when `verification.confirmed=true`.

## YouTube

`youtube_play` accepts only YouTube URLs. It defaults to the kitchen TV and supports an explicit bedroom target:

- `target=cocina` -> `media_player.tv_cocina_2`
- `target=dormitorio` -> `media_player.tv_dormitorio_2`

It sends the URL through Home Assistant `media_player.play_media` with `media_content_type=url`, then polls the relevant TV entities inside the same request. The response contains a `verification` object with `confirmed`, `level`, timing, evidence and compact state snapshots.

When the caller knows the intended video title it may pass `expectedTitle`; matching that title provides stronger verification. If the user names a video or song instead of supplying a URL, the agent should first resolve a concrete YouTube URL. For the fast CMD client, prefer passing the extracted YouTube video ID instead of a URL with extra query parameters; the client builds the canonical URL internally.

## Stremio target and language policy

Stremio defaults to the kitchen TV. When the user does not name a TV, omit `target` or use `target=cocina`.

When the user explicitly asks for the bedroom TV, use:

```powershell
C:\sol\sol-fast.ps1 media_play "title" '{"target":"dormitorio"}'
```

The Home Assistant plugin maps:

- `target=cocina` -> the configured `HA_SOL_TV_REMOTE_ENTITY_ID`
- `target=dormitorio` -> `HA_SOL_TV_DORMITORIO_REMOTE_ENTITY_ID`, defaulting to `remote.tv_dormitorio`

The selected target applies to both the Stremio deep-link launch and every DPAD key used for native stream-index selection. The target is also part of the playback dedupe key, so the same content can be launched independently on both TVs.

Stremio has no forced language by default. When no language is explicitly requested, the agent must omit the `language` field and the Stremio path uses `any`.

Only explicit user requests should map to:

- Spanish -> `language=spanish`
- Latin Spanish -> `language=latin`
- English -> `language=english`

The Home Assistant plugin's old manual Spanish-title policy is disabled by default. It can only be re-enabled with `HA_SOL_STREMIO_MANUAL_SPANISH_POLICY=true`.

## Runtime paths

Current household deployment:

- Server: `C:\SOL\SOL\apps\server\sol-fast-server.mjs`
- Fast client: `C:\sol\sol-fast.cmd`
- Full wrapper: `C:\sol\sol-fast.ps1`
- Loopback HTTP: `127.0.0.1:8770`

The bridge is intentionally loopback-only.
