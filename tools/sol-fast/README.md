# SOL Fast local bridge

SOL Fast is the low-latency local bridge used by ChatGPT Voice through Remote Desktop Commander on the household HTPC.

## Architecture

```
ChatGPT / Voice
  -> Remote Desktop Commander
  -> C:\sol\sol-fast.ps1
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

## Quick commands

Examples:

```powershell
C:\sol\sol-fast.ps1 tv_cocina
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

After an action, the calling agent should read the relevant live state again before claiming success.

## YouTube

`youtube_play` accepts only YouTube URLs and sends the URL to `media_player.tv_cocina_2` with Home Assistant `media_player.play_media` and `media_content_type=url`.

When the user names a video or song instead of supplying a URL, the agent should first resolve a concrete YouTube URL and then call `youtube_play`.

## Stremio language policy

Stremio has no forced language by default. When no language is explicitly requested, the agent must omit the `language` field and the Stremio path uses `any`.

Only explicit user requests should map to:

- Spanish -> `language=spanish`
- Latin Spanish -> `language=latin`
- English -> `language=english`

The Home Assistant plugin's old manual Spanish-title policy is disabled by default. It can only be re-enabled with `HA_SOL_STREMIO_MANUAL_SPANISH_POLICY=true`.

## Runtime paths

Current household deployment:

- Server: `C:\SOL\SOL\apps\server\sol-fast-server.mjs`
- Wrapper: `C:\sol\sol-fast.ps1`
- Loopback HTTP: `127.0.0.1:8770`

The bridge is intentionally loopback-only.
