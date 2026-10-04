# BWA 3D SOL plugin

Business integration plugin for BWA 3D.

## Mercado Libre module

The first module connects SOL to Mercado Libre's official DevSite MCP endpoint:

`https://mcp.mercadolibre.com/devsite/v1/mcp`

Current SOL tools:

- `bwa_3d_status`
- `bwa_3d_mercadolibre_mcp_status`
- `bwa_3d_mercadolibre_mcp_login`
- `bwa_3d_mercadolibre_mcp_logout`
- `bwa_3d_mercadolibre_docs_search`
- `bwa_3d_mercadolibre_docs_page`

OAuth for the official MCP is handled through `mcp-remote`. Authentication data is kept in the plugin's own SOL plugin-data directory, never in source control.

The official DevSite MCP currently provides developer-documentation access. Seller-account operations such as orders, listings, claims and messages will use Mercado Libre's API with a BWA 3D application and Authorization Code OAuth. The manifest already includes settings for App ID, Client Secret and exact HTTPS Redirect URI. Write operations remain disabled by default.

## Correo module

Reserved for the next stage.
