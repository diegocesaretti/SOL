# SOL Voice Facade

## Value Proposition
Expose the existing SOL Full MCP to ChatGPT Voice through a small conversational tool surface without duplicating SOL, Nexo, Home Assistant, Stremio, WhatsApp, or memory logic.

Target user: an authenticated SOL household member using ChatGPT, especially Voice on mobile.

Current pain: the SOL gateway dynamically exposes dozens of low-level tools. This preserves capability but makes tool selection noisier than necessary for short spoken requests.

Core actions:
1. Read live home/device state by natural name.
2. Perform explicit home/media actions.
3. Search SOL/Nexo/WhatsApp/memory context.
4. Retain access to every advanced SOL capability through dynamic discovery.

## Why LLM?
Conversational win: requests such as "¿está prendida la tele de la cocina?" or "poné Los Simpson" are faster to say than navigating a dashboard.
The LLM contributes intent interpretation, entity disambiguation and deciding which facade capability is appropriate.
SOL remains the source of truth for live state, private data and real actions.

## UI Overview
No UI is required for the primary Voice flow. Tool output is returned directly to the conversation.
A visual dashboard can be added later without changing the backend facade.
## Product Context
- Existing product: SOL Full running on the user's HTPC.
- Existing remote MCP gateway: `https://sol-plugin-gateway.onrender.com/mcp`.
- Existing bridge: outbound-only authenticated SOL bridge with OAuth scopes `sol.read`, `sol.submit`, and `sol.actions`.
- Existing catalog: dynamic SOL tools from Nexo, Home Assistant, Stremio, memory and installed plugins.
- Constraint: do not duplicate provider logic or bypass SOL permission/confirmation boundaries.

## UX Flows
### Home state
1. User asks for a live device/entity state.
2. ChatGPT calls `sol_home_find`.
3. SOL returns current cached Home Assistant matches/states.

### Home action
1. User explicitly requests a device action.
2. ChatGPT resolves the entity with `sol_home_find` when needed.
3. ChatGPT calls `sol_home_action` using the existing Home Assistant service tool.

### Media playback
1. User asks to play a movie/series.
2. ChatGPT calls `sol_media_play`.
3. SOL Full executes the existing deterministic Stremio playback flow.

### Context and memory
1. User asks about WhatsApp, SOL memory or broader SOL context.
2. ChatGPT uses the corresponding facade search tool.

### Advanced capability
1. No facade tool fits the request.
2. ChatGPT calls `sol_find_capability`.
3. ChatGPT invokes the selected remote tool through a scope-specific dynamic runner.

## Tool Exposure
Modes: `raw`, `facade`, `both`. Production ChatGPT should use `facade`; rollback can switch to `both` or `raw` without code changes.