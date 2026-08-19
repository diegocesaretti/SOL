# SOL + Codex

SOL uses **Codex App Server** as its first AI runtime adapter. The domain depends only on `AiProvider`; Codex-specific authentication and JSON-RPC stay inside `modules/ai/codex`.

## Why App Server

SOL needs a product-style integration rather than a shell wrapper: ChatGPT authentication, account state, rate limits and streamed turns. Codex App Server exposes those capabilities over newline-delimited JSON on stdio.

Official references:

- https://developers.openai.com/codex/app-server
- https://developers.openai.com/codex/auth
- https://developers.openai.com/codex/codex-sdk

## Runtime

SOL starts:

```text
codex app-server
```

and performs the required protocol handshake:

```text
initialize
initialized
```

The executable can be overridden with `SOL_CODEX_BIN`.

## Authentication

The `/ai` screen supports:

1. ChatGPT browser OAuth (`account/login/start`, type `chatgpt`)
2. ChatGPT device-code login (`chatgptDeviceCode`) for headless/remote cases
3. Account status (`account/read`)
4. Rate-limit status (`account/rateLimits/read`)
5. Logout (`account/logout`)

SOL never copies ChatGPT OAuth tokens into PostgreSQL. Codex owns and refreshes its login cache. By default this uses the normal Codex credential location/OS credential store. `SOL_CODEX_HOME` can isolate a dedicated Codex home later if desired.

## Reasoning security boundary

`CodexProvider` is intentionally narrower than a normal coding session:

- approval policy: `never`
- read-only/restricted sandbox for reasoning turns
- no SOL write tools are granted
- source/context text is wrapped as untrusted data
- inbound WhatsApp/email/document text is never promoted to tool/system authority

This is only one layer. Before future source data reaches the provider, SOL's own household/member visibility filtering must already have removed unauthorized records.

## Household scope

The first implementation uses one host-level Codex identity for the SOL instance. Household members may use that shared reasoning engine, while SOL controls which context each member may retrieve.

If SOL later needs separate ChatGPT identities per household/member, each Codex identity should run in an isolated `CODEX_HOME`/App Server process rather than sharing one mutable login cache.

## SDK follow-up

OpenAI recommends Codex SDK for automated jobs/CI and App Server for deep product integrations. After real-world use we can keep App Server for auth/interactive turns and optionally add a SDK-backed worker for batch consolidation/planning without changing the `AiProvider` contract.
