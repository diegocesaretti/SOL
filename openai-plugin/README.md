# SOL plugin for ChatGPT

This package accompanies the public SOL MCP gateway.

Production MCP URL:

```text
https://sol-plugin-gateway.onrender.com/mcp
```

The URL is a deployment target. If Render assigns a different hostname, update `plugin.json` and `mcp.json` before submission.

The plugin combines:
- a remote Streamable HTTP MCP server;
- OAuth 2.1 authorization-code + PKCE;
- an outbound-only bridge from the user's private SOL installation;
- a skill that tells ChatGPT to verify live Home Assistant state and preserve SOL confirmation/permission boundaries.

Public submission uses **With MCP** in the OpenAI plugin submission portal. The portal should scan the production MCP URL directly; this folder provides the portable plugin identity and skill content.
