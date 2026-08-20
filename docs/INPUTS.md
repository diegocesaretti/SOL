# SOL Inputs

`/inputs` is the primary place to manage data origins that feed SOL.

## Mental model

```text
Inputs -> source_items -> Life -> Knowledge -> MCP
```

A source item does **not** need to be AI-relevant to appear in Life. In particular, normal WhatsApp messages are persisted as source items before the local relevance/candidate gate is considered.

## Unified source health

For every visible input SOL reports:

- connector/source status;
- runtime state when available (WhatsApp and Home Assistant);
- total source items persisted;
- source items observed during the last 24 hours;
- text-bearing item count;
- last item time;
- last observation time;
- recent raw-normalized feed.

This intentionally separates connector health from Life presentation.

### WhatsApp diagnostic rule

If a WhatsApp input shows:

```text
runtime: open
total items: 0
```

then the problem is upstream of Life: the linked device is open but Baileys messages have not been persisted to `source_items`.

If `Ver feed` contains the expected messages but `/life` does not, the issue is in Life visibility/query/rendering instead.

That distinction is the first debugging step for any missing-message report.

## Editing inputs

Inputs can be renamed. A manageable input can also be changed between:

- **personal**: source items/conversations are private and owned by that member;
- **family**: source items/conversations use family visibility.

Changing that setting propagates owner/visibility to already imported source items and conversations from that source.

Private inputs of another member are not made readable/manageable merely because the viewer is household owner.

## Removing inputs

Removing an input is destructive. The UI warns that imported data for that source will be removed by PostgreSQL cascading foreign keys. WhatsApp and Home Assistant runtimes are stopped before deletion and configured accounts are restarted afterward.

## Adding inputs

The unified UI starts setup for:

- WhatsApp linked-device (including QR inside `/inputs`);
- Google Calendar OAuth;
- Home Assistant URL + Long-Lived Access Token;
- Mercado Libre OAuth.

Provider-specific pages remain available as **advanced configuration** for detailed connector settings.

## Windows tray

On Windows, SOL starts `scripts/windows/sol-tray.ps1` unless:

```dotenv
SOL_TRAY=false
```

The tray companion polls `/health` every five seconds:

- green `S`: SOL responds and the database is healthy;
- red `S`: SOL or its database is unavailable;
- yellow `S`: startup/unknown state.

Double-click opens `/inputs`. The context menu also exposes SOL home and Life.
