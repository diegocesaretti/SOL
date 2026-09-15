# Stremio SOL control overlay

Experimental semantic-control integration for `stremio-native/stremio-android`.

Pinned upstream commit: `4bdef3b6be1186d9aa22acd8b3ec391c22f0e083` (`master`, 2026-07-02).

The goal is to replace fragile screenshot/DPAD automation for normal Stremio tasks with a small authenticated LAN API connected directly to Stremio's existing `StremioCore`, `CatalogRepository`, `PlaybackRepository`, and `Player` instances. Home Assistant / computer-use remains useful for TV power, launching the app, unexpected permission dialogs, and other non-Stremio UI.

## Architecture

```text
Codex / Voice / WhatsApp
        |
       SOL
        |
Stremio Control SOL plugin
        |
 authenticated LAN HTTP
        |
Stremio Android + SOL overlay
        |
Stremio Core + existing Player
```

The Android overlay does not emulate DPAD keys and does not scrape the UI. Search uses the user's installed Stremio catalogs. Series episode IDs come from Stremio metadata. Playback resolves streams through the same core/repository path used by the app. Pause, seek, audio and subtitle selection operate on the actual active `Player`.

## Security model

- API listens on TCP `8768` on the Android device.
- `/api/v1/health` is public and exposes only service/pairing state.
- `/api/v1/pair` works only while a pairing window was explicitly opened from Stremio Android Settings.
- Pairing code is six digits, expires after five minutes and is invalidated after ten failed attempts.
- Successful pairing creates a random 256-bit bearer token.
- All other routes require the bearer token.
- Token is stored in Android private SharedPreferences and in SOL's private plugin data directory; it is never intentionally logged.
- The SOL plugin callback itself listens only on `127.0.0.1`.
- Do not port-forward TCP 8768 or expose it directly to the Internet. This is a trusted-LAN control surface.

## API v1

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/v1/health` | Reachability and pairing state |
| POST | `/api/v1/pair` | Exchange visible one-time code for bearer token |
| GET | `/api/v1/status` | Current Stremio/player summary |
| GET | `/api/v1/player` | Runtime player state and tracks |
| POST | `/api/v1/search` | Search installed Stremio catalogs |
| POST | `/api/v1/details` | Get real videos/episodes and `videoId`s |
| POST | `/api/v1/play` | Resolve a Stremio stream and play it |
| POST | `/api/v1/player/pause` | Pause |
| POST | `/api/v1/player/resume` | Resume |
| POST | `/api/v1/player/seek` | Absolute or relative seek |
| POST | `/api/v1/player/audio` | Select audio track |
| POST | `/api/v1/player/subtitle` | Select subtitle track |
| POST | `/api/v1/player/subtitle/off` | Disable subtitles |

For a series, the intended sequence is `search -> details -> play(videoId=...)`. `play` deliberately rejects a series without a real `videoId`; Codex should never invent episode identifiers.

## Apply to a local Stremio checkout

From a SOL checkout on Windows/PowerShell:

```powershell
./integrations/stremio-sol-overlay/apply-overlay.ps1 -TargetPath C:\src\stremio-android
```

The script refuses to modify a checkout whose HEAD differs from the pinned upstream commit unless `-AllowDifferentUpstream` is explicitly supplied. It copies the overlay sources, wires the server into `MainApplication`, wires remote playback to the existing `PlayerScreen` state in `MainViewModel`, adds pairing controls to Android Settings, and runs `:app:compileDebugKotlin` unless `-SkipBuild` is supplied.

CI performs the same operation against a fresh checkout of the pinned upstream and compiles Kotlin. It does not publish an APK.

## SOL plugin

`plugins/stremio-control` exposes these SOL MCP tools:

- `stremio_status`
- `stremio_player_state`
- `stremio_search`
- `stremio_details`
- `stremio_pair`
- `stremio_play`
- `stremio_pause`
- `stremio_resume`
- `stremio_seek`
- `stremio_select_audio`
- `stremio_select_subtitle`
- `stremio_disable_subtitles`

`stremio_pair` requires `confirmedByUser=true`. Playback mutations also require `STREMIO_SOL_ALLOW_CONTROL=true` in the plugin settings. Read tools still require a successfully paired Stremio endpoint, except `stremio_status`, which can probe `/health` before pairing.

## Known boundaries

The overlay currently assumes the Stremio process is alive. It can open the app's existing player UI once the process/ViewModel is active, but Android app foregrounding/power/input should remain a Home Assistant responsibility for now. This keeps the semantic API focused and avoids Android background-activity-launch restrictions.

The first stream is selected by default (`streamIndex=0`). The API exposes deterministic stream-index selection but does not yet implement SOL-side quality/source ranking. A later version can return stream candidates separately and let SOL choose based on quality, addon, seed count or user preferences before calling play.

## Upstream licensing note

At the pinned commit, GitHub repository metadata does not identify a repository-wide license and no root `LICENSE` file was found during the integration audit; third-party license files exist for bundled components. Keep this overlay/source work separate and do not publish or redistribute a modified Stremio APK until the upstream project's redistribution terms are confirmed. Compiling an ephemeral CI checkout is used only as a compatibility check and no APK is uploaded.
