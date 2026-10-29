# SOL Agent — experimental 0.1.0 (shadow mode)

**This is a development-only plugin.** It does not replace Pulse, run device actions, change listings, control printers, or send Nexo/WhatsApp messages. Default: `autoStart=false`, no sources configured, local-model inference disabled.

## Purpose
SOL Agent is a deliberately small compatibility bridge for future agentic reasoning, inspired by the architectural patterns of Rakazo. It **does not yet copy or vendor Rakazo source code**. Dependency/licensing review and a proper Pi adapter are future work.

It uses SOL's existing plugin lifecycle and owner-scoped `/v1/plugin-api/mcp/tools/invoke-read` endpoint; tool arguments are explicitly configured rather than guessed. That permits data sources from any existing plugin **only when SOL authorizes that read tool**. This is not yet proof of end-to-end compatibility with every plugin.

## Configuring sources (manual, least-privilege)
`SOL_AGENT_SOURCES_JSON` is a JSON array with up to 16 entries:
```json
[
  {"id":"home-kitchen","name":"home_assistant_get_state","arguments":{"entityId":"climate.aire_cocina"}},
  {"id":"finance-due","name":"finanzas_vencimientos_list","arguments":{"limit":20}}
]
```
These are examples, not automatic installation settings. Do not include passwords, camera feeds, location histories or sensitive data. Read access is subject to SOL's owner permissions and its read-tool gate.

## Intelligence and privacy
Requires a local OpenAI-compatible model endpoint (e.g. a locally served model at `http://127.0.0.1:11434/v1/chat/completions`). To use it, explicitly configure `SOL_AGENT_MODEL_ENABLED=true` and `SOL_AGENT_MODEL_NAME`. The plugin rejects remote model endpoints; it never sends personal tool data to cloud AI.

On the first observation it establishes a baseline. Later changes can produce up to five reasoned proposals per cycle (max eight model analyses per day). Findings are kept under SOL's plugin-data directory; only proposal summaries, hashes and source IDs are stored, not raw tool snapshots. Errors do not produce phantom proposals and do not advance failed checkpoints.

## Read-only tools
- `sol_agent_status`: health, counts and model configuration, no personal data.
- `sol_agent_proposals`: proposal summaries for review; no external action.
No write, approve, execute or send tool is registered. Local `GET /health` binds to 127.0.0.1 only.

## Tests
```sh
node --test plugins/sol-agent/*.test.mjs
node scripts/pack-sol-plugin.mjs plugins/sol-agent dist/SOLAgent-0.1.0.solplugin
```

## Production safeguards
Only a dedicated development branch. Before any install: test the package against the latest SOL host; inspect the API read permissions, privacy scopes and failure modes; run side by side with Pulse; measure false positives and resource consumption. Never deploy to the HTPC, update `SOL-Full`, or merge to `main` without an explicit review.
