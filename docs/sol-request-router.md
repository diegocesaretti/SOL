# SOL Request Router

`sol_request` is a high-level natural-language tool implemented inside SOL Main/Core. It is not a plugin and it does not replace the canonical MCP tools.

## Purpose

Clients that already know the exact SOL MCP tool should call that tool directly.

Clients that only have a natural-language request may call:

```json
{
  "text": "Poné Los Simpson en la TV del dormitorio",
  "confirmedByUser": true
}
```

SOL decides how to route it.

## Routing

```
sol_request
  |
  +-- deterministic fast router
  |     +-- Home Assistant state
  |     +-- Home Assistant on/off
  |     +-- YouTube URL playback
  |     +-- Stremio playback
  |
  +-- Codex OAuth planner fallback
        |
        +-- Codex selects the next canonical SOL tool
        +-- SOL validates scope + confirmation + tool availability
        +-- SOL executes the tool itself
```

Codex never receives direct authority to invoke SOL tools from this router. It only proposes a structured plan. SOL remains the security and execution boundary.

## Fast-path policy

- Kitchen is the default media target.
- Bedroom is selected only when explicitly requested.
- Stremio language is unrestricted by default.
- `language=spanish|latin|english` is sent only when the user explicitly asks for that language.
- Real-world actions require `confirmedByUser=true`.
- Home Assistant targets are resolved from the live cache instead of hardcoded entity ids.
- Actions read the live state again after execution before returning verification.

## Codex fallback

The planner uses the locally authenticated Codex CLI with:

- existing ChatGPT OAuth;
- `--ignore-user-config`;
- ephemeral/read-only execution;
- constrained structured output;
- a limited candidate catalog selected by SOL.

The planner proposes tool + arguments. SOL validates and invokes the canonical tool.

Simple reads stop after the first tool result. Another planner step is allowed only for requests that genuinely require another SOL tool, such as comparing sources or sending/acting on retrieved data.

Environment controls:

- `SOL_CODEX_PATH`: optional explicit Codex executable.
- `SOL_ROUTER_CODEX_TIMEOUT_MS`: planner timeout, default 25 seconds.
- `SOL_ROUTER_AGENT_STEPS`: maximum agent steps, default 3.

## MCP surface

`sol_request` is a normal SOL MCP tool. It is also exposed by the ChatGPT plugin gateway facade.

Direct MCP tools remain canonical. Once a client can consume the complete SOL MCP catalog reliably, it can bypass `sol_request` for known capabilities and use the router only when orchestration adds value.

## Migration / cleanup

Do not remove the existing SOL Fast or legacy bridges merely because `sol_request` exists.

Removal is a later migration step after production verification proves that no active client depends on:

- `sol-fast-server.mjs`;
- `sol-fast.ps1` / `sol-fast.cmd`;
- `sol-full-bridge.mjs` or its watchdog;
- facade aliases or duplicated compatibility paths.

The canonical plugin tools themselves must remain.
