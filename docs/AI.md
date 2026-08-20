# SOL optional AI providers

SOL is data/knowledge first. AI is optional enrichment, not storage, authentication, privacy enforcement, or action authority.

```text
Inputs → Life → local/deterministic filters → AI when useful → Knowledge
                                                   │
                                                   ├─ OpenAI API
                                                   ├─ Codex / ChatGPT OAuth
                                                   └─ none
```

## Provider routing

Configure:

```dotenv
SOL_AI_PROVIDER=auto
```

Allowed modes:

- `auto`: prefer OpenAI when an API key is configured; if an OpenAI request fails or OpenAI is unavailable, try Codex.
- `openai`: only OpenAI API may be used.
- `codex`: only the Codex App Server / ChatGPT OAuth adapter may be used.

If no allowed provider is available, source ingestion continues. Candidate extraction and automatic consolidation remain deferred rather than blocking WhatsApp, Gmail, Life, or MCP.

## OpenAI API

SOL uses the OpenAI **Responses API** directly over HTTPS. No OpenAI SDK dependency is required.

```dotenv
SOL_OPENAI_API_KEY=
# OPENAI_API_KEY is also accepted.
SOL_OPENAI_BASE_URL=https://api.openai.com/v1
SOL_OPENAI_FAST_MODEL=gpt-5.4-nano
SOL_OPENAI_MODEL=gpt-5.4-mini
SOL_OPENAI_REQUEST_TIMEOUT_MS=45000
SOL_OPENAI_MAX_OUTPUT_TOKENS=4000
```

The API key is read only from the process environment / local `.env`. SOL does not save it in PostgreSQL, source items, Knowledge, MCP, or the web UI.

`SOL_OPENAI_BASE_URL` exists so a compatible endpoint can be selected without changing the domain. The current adapter expects an OpenAI Responses-compatible `/responses` endpoint; Chat Completions-only compatibility is not part of v0.11.

### Model routing

To keep high-volume enrichment cheap:

```text
classification / automation → SOL_OPENAI_FAST_MODEL
conversation / consolidation / planning → SOL_OPENAI_MODEL
```

Both aliases are configuration, not domain assumptions. They can be replaced with another compatible model without code changes.

## Privacy and source safety

Every provider receives only the context explicitly assembled by the calling SOL module. The provider wrapper tells the model that source content is untrusted data and must never be followed as instructions.

OpenAI requests set:

```json
{"store": false}
```

SOL still performs its own privacy filtering before a request is created. Provider selection never widens a member's visibility.

## Current uses

The generic provider router is used for:

- realtime WhatsApp candidate classification;
- deferred candidate recovery;
- automatic Life → Knowledge consolidation;
- `/ai` provider test.

The deterministic parts of SOL do not need a model:

- ingestion and source deduplication;
- Life persistence;
- privacy/identity checks;
- MCP reads and structured MCP schedule submissions;
- deterministic schedule normalization;
- Executive permissions and approval enforcement.

The dedicated SOL WhatsApp conversational adapter still has some Codex-specific integration code in v0.11 and can be moved onto the same router separately; this does not affect source filtering or Life → Knowledge organization.

## Operational recommendation

For a household deployment, start with:

```dotenv
SOL_AI_PROVIDER=auto
SOL_OPENAI_FAST_MODEL=gpt-5.4-nano
SOL_OPENAI_MODEL=gpt-5.4-mini
```

and keep the local prefilter enabled. Do not send every stored message to the model. Let the deterministic filter select candidates and let consolidation process bounded groups of source items.

Use `/ai` to see the configured mode, active provider, model aliases, and to run a minimal test. The UI never displays or accepts the OpenAI API key.
