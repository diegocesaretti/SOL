# Home Assistant SOL plugin

Home Assistant bridge for SOL. Stremio intentionally has one playback architecture:

`SOL MCP -> Home Assistant plugin -> Cinemeta/account -> all account stream addons -> proven native index -> official Stremio -> Home Assistant remote keys`

There is no Android TV Satellite, Accessibility service, screenshot observer, MCP forwarding proxy, audience-classifier wrapper, launch guard, generic first-stream autoclick, focus nudge, addon-ranking runtime or alternate provider-profile playback path.

## Stremio playback

`home_assistant_stremio_play_best` is the only playback tool. It:

1. Resolves the movie or episode with Cinemeta. Series may use linked Stremio history to resume or choose the next released episode.
2. Refreshes the linked Stremio account and reads stream addons in native account order.
3. Queries each account addon directly at its stream resource URL, preserving account order, provider order and duplicate visual entries.
4. Applies configured default quality/language, overridden by explicit tool arguments.
5. Proves the selected stream's absolute native index. If an earlier provider query failed or the index cannot be proven, playback fails closed.
6. Opens the official Stremio detail page with `autoPlay=false`; there is no competing first-stream autoplay path.
7. Waits `HA_SOL_STREMIO_OPEN_TO_KEYS_DELAY_MS`.
8. Sends each `DPAD_RIGHT`/`DPAD_LEFT` in its own Home Assistant `remote.send_command` call, awaits the call, then applies the configured inter-key delay.
9. Waits the independent selection delay and sends exactly one final scalar `DPAD_CENTER` or `ENTER`, optionally held for the configured duration.

The plugin does not claim playback confirmation because it intentionally has no visual-observation subsystem.

## Stremio settings kept intentionally

Only settings that alter the active path remain: account credentials, one Android TV remote entity, provider timeout, default quality/language, startup delay, inter-key delay, initial focus index, pre-select delay, final select key and select-key hold duration.

## Home Assistant

The non-Stremio part remains event-driven: entity cache, Person sync, services and direct Home Assistant TV navigation are unchanged.
