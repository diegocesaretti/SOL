# BWA 3D SOL plugin

Business integration plugin for BWA 3D.

## Mercado Libre

Two separate integrations live in the same plugin.

### Official DevSite MCP

Uses Mercado Libre's official MCP endpoint for current developer documentation:

`https://mcp.mercadolibre.com/devsite/v1/mcp`

Tools cover MCP login/status plus documentation search/page retrieval. MCP auth is isolated under the plugin's SOL plugin-data directory.

### Seller API

Version 0.2.0 implements Mercado Libre seller OAuth and operational API access.

- Authorization Code OAuth with state validation.
- Optional PKCE when enabled in the Mercado Libre application.
- Access-token auto refresh before expiry.
- Rotating refresh tokens are persisted atomically.
- Seller tokens are encrypted at rest with Windows DPAPI for the current SOL user.
- API host is pinned to `https://api.mercadolibre.com`.
- Generic headers cannot override Authorization, Host, cookies or Content-Length.
- Write operations require SOL action scope, explicit current-user confirmation and `mercadolibre_allow_write=true`.

Convenience tools cover seller profile/reputation, publications, current prices, orders, shipments, questions, post-sale messages and claims. The generic read/action tools keep new Mercado Libre API resources usable without waiting for a plugin update.

Current item bulk reads use `/items/bulk`. Shipment reads send `x-format-new: true`. Questions use API v4. Claims use `/post-purchase/v1/claims`.

### Required seller-app settings

Configure these in SOL Services after creating a Mercado Libre developer application:

- `mercadolibre_client_id`
- `mercadolibre_client_secret`
- `mercadolibre_redirect_uri`
- optional `mercadolibre_pkce`
- `mercadolibre_allow_write` (default false)

After configuration, `bwa_3d_mercadolibre_api_login` opens the Mercado Libre authorization page. Complete OAuth with the returned authorization code or final redirect URL.

## Correo

Reserved for the next BWA 3D module.
