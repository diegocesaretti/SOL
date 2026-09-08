# Official plugin compatibility

SOL accepts manifest schemas 1 and 2. Schema 2 `requires` entries are checked
against `SOL_PLUGIN_HOST_CAPABILITIES`; unknown requirements are rejected before
installation. GitHub package validation compares schema, identity, version,
capabilities, requirements and permissions with the reviewed descriptor.

Both callback formats use the same in-memory tool registry:

| Registration | Permission | Callback |
| --- | --- | --- |
| `/v1/plugin-api/tools/register` | `tool.register`, `tool.execute` | `<baseUrl>/api/sol-tools/<name>` with the arguments as the body |
| `/v1/plugin-api/mcp/tools/register` | `mcp.register` | Exact `callbackUrl` with `sol.plugin.mcp.invoke`, `tool`, `arguments` and caller scope |

The compatibility adapter preserves JSON Schema arguments and public tool names,
including Audio Remote's `codex_audio_*` names. It accepts Home Assistant's
`requiredScope` and Audio Remote's `requiresSubmit`; any non-read scope or
`requiresSubmit: true` requires the current SOL `external_action` access scope.
Schema constraints such as `confirmedByUser: { const: true }` remain enforced.

Tools retain the current unified registry's member/household scope. Legacy
`visibility: family` does not widen access. Revoked process tokens remove the
registration; restart requires registration with the new token. Callback URLs
must use HTTP loopback, and redirects are rejected.

SOL-Full's pinned packages (Nexo 0.9.0, Home Assistant 0.1.0 and Audio Remote
1.2.1) pass static package validation against this host. Deploying the fix still
requires a new SOL Windows release and updated asset pins in SOL-Full. Static
validation does not prove live WhatsApp, Home Assistant or audio operation.
