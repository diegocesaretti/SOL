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

SOL never copies ChatGPT OAuth tokens into PostgreSQL. Codex owns the OAuth lifecycle and refreshes managed ChatGPT tokens automatically.

### Dedicated SOL Codex profile

SOL intentionally does **not** use the developer's normal `~/.codex` login by default. It runs App Server with:

```text
CODEX_HOME=<repo>/.sol/codex
```

and creates a private `config.toml` containing:

```toml
cli_auth_credentials_store = "file"
forced_login_method = "chatgpt"
```

The `.sol/` directory is gitignored. On platforms that honor POSIX modes SOL creates the directory as `0700` and the config as `0600`. The resulting `auth.json` must still be treated like a password because it contains access tokens.

This isolation means signing SOL in or out does not intentionally reuse or revoke the ordinary Codex CLI/IDE cache used for development. `SOL_CODEX_HOME` can point to another dedicated persistent location when SOL is moved to a server or container.

## Reasoning security boundary

`CodexProvider` is intentionally narrower than a normal coding session:

- approval policy: `never`
- read-only/restricted sandbox for reasoning turns
- no SOL write tools are granted
- source/context text is wrapped as untrusted data
- inbound WhatsApp/email/document text is never promoted to tool/system authority

This is only one layer. Before future source data reaches the provider, SOL's own household/member visibility filtering must already have removed unauthorized records.

## Household scope

The first implementation uses one SOL-level Codex identity for the running SOL instance. Household members share that reasoning engine while SOL controls which records each authenticated member can retrieve and send as context.

If SOL later needs separate ChatGPT identities per household/member, each identity should run in its own `CODEX_HOME` and App Server process rather than sharing mutable auth state.

## SDK follow-up

OpenAI recommends Codex SDK for automated jobs/CI and App Server for deep product integrations. After real-world use we can keep App Server for auth/interactive turns and optionally add a SDK-backed worker for batch consolidation/planning without changing the `AiProvider` contract.
