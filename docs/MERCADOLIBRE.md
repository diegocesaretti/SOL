# Mercado Libre connector

Mercado Libre is a first-class SOL **business source**. The current connector is deliberately read-only: it imports seller/account context, publication snapshots, recent orders and questions, but exposes no endpoint that changes Mercado Libre.

## Architecture

```text
Mercado Libre OAuth + PKCE
          │
          ▼
      seller identity
          │
   ┌──────┼──────────┐
   ▼      ▼          ▼
 items  orders   questions
   │      │          │
   │      └────┬─────┘
   │           ▼
 snapshots   source_items
   │           │
   └─────┬─────┘
         ▼
        SOL
 Life / business dashboard
```

## OAuth configuration

Create a Mercado Libre application and configure the exact redirect URI that SOL will use.

Mercado Libre requires HTTPS for redirect URIs when creating an application. PKCE is optional in Mercado Libre, but SOL intentionally uses the S256 PKCE flow and therefore the application should have PKCE enabled.

Example `.env`:

```dotenv
SOL_MERCADOLIBRE_CLIENT_ID=...
SOL_MERCADOLIBRE_CLIENT_SECRET=...
SOL_MERCADOLIBRE_REDIRECT_URI=https://your-sol-host.example/v1/mercadolibre/callback
SOL_MERCADOLIBRE_AUTH_URL=https://auth.mercadolibre.com.ar/authorization
SOL_MERCADOLIBRE_SYNC_MS=3600000
```

The redirect URI must match the value registered in Mercado Libre exactly. SOL refuses to start the Mercado Libre authorization flow when the configured redirect URI is not HTTPS rather than silently substituting the localhost development URL.

The default authorization domain is Argentina (`.com.ar`). `SOL_MERCADOLIBRE_AUTH_URL` can be overridden for a different site/country.

## Credential storage

SOL stores OAuth credentials encrypted at rest:

```text
PostgreSQL / Neon
└── AES-256-GCM encrypted access + refresh token payload

SOL host only
└── .sol/secrets/mercadolibre-oauth.key
```

Client secret remains in the Git-ignored `.env` file.

Mercado Libre refresh tokens are single-use and rotate every time they are exchanged. SOL therefore serializes token refresh for each source account with a PostgreSQL transaction/advisory lock and atomically saves the newly returned access + refresh token pair.

## Identifier safety

Mercado Libre is moving user identifiers to Int64. JavaScript `number` cannot exactly represent every 64-bit integer.

The connector uses a lossless JSON preprocessing step for unsafe integer literals and stores external IDs as text. Seller, buyer, order, pack and shipping identifiers therefore are not forced into Int32/unsafe JavaScript numbers.

## Source privacy

A Mercado Libre account can be created as:

```text
personal source
  owner_member_id = member
  visibility      = private

shared business source
  owner_member_id = NULL
  visibility      = family
```

Owner/admin status does not grant access to another member's private seller data. An owner/adult may see the existence of a source account in household inventory, but SOL does not expose that private account's seller ID, nickname, dashboard, orders or questions to them.

## Synchronization

Until SOL has a hardened public HTTPS notification endpoint, Mercado Libre uses bounded reconciliation. The default scheduler runs every hour and manual sync is available in `/mercadolibre`.

Each pass currently bounds work to approximately:

```text
500 publications
200 recent orders
100 recent questions
```

This is intentional for the prototype profile and avoids turning a first reconciliation into an unbounded scan. Later, webhook notifications and cursor/scan jobs can provide a more complete business history.

### Publications

SOL calls the seller item search and item multiget resources. Publications are stored as an operational snapshot:

- title/status;
- price/currency;
- available/sold quantity returned by the API;
- listing type/condition;
- permalink;
- seller custom field/SKU-related value;
- timestamps.

Publication snapshots do not create Timeline entries every time quantity or price changes.

### Orders

Recent seller orders are persisted idempotently and create a standard Life/source item:

```text
kind        mercadolibre_order
visibility  private or family, inherited from source account
body        status / amount / minimal buyer reference
metadata    order id / shipping id / amount / currency
```

SOL deliberately does not retain buyer addresses or fiscal details in this first business core.

### Questions

Recent questions are persisted idempotently and also create source items:

```text
kind        mercadolibre_question
visibility  private or family, inherited from source account
body        buyer question text
metadata    question id / item id / status / answered flag
```

Observed question text remains **source data**, not an instruction to SOL.

## Dashboard

Open:

```text
http://127.0.0.1:3000/mercadolibre
```

The dashboard shows the locally synchronized window:

- orders loaded;
- revenue from loaded orders whose status is `paid`;
- active publication count;
- unanswered-question count;
- recent orders;
- recent questions;
- publication snapshot.

Revenue is explicitly a summary of the data loaded into SOL, not a guaranteed lifetime/accounting total.

## Read-only action boundary

The current connector does **not** expose:

- price changes;
- stock changes;
- item creation/edit/pause/close;
- question replies;
- shipping actions;
- payment actions.

Future writes must be implemented separately as actions with authenticated member capability checks, business-scoped permissions, risk policy and `action_log` auditing.

## Notifications — next stage

Mercado Libre supports application topics such as Orders, Items, Messages, Shipments and related resources. SOL intentionally does not configure webhook ingestion yet because the localhost development profile is not a hardened public callback service.

Once deployment hardening provides HTTPS, the preferred direction is:

```text
Mercado Libre notification
        ↓
validate notification/resource
        ↓
fetch authoritative resource with seller token
        ↓
idempotent reconciliation
        ↓
Life / business state
```

Polling remains a recovery/reconciliation path rather than the long-term realtime mechanism.

## Current test boundary

Unit coverage includes lossless parsing of unsafe Int64 identifiers. A real integration test still needs to run with an actual Mercado Libre application/account and should verify:

1. HTTPS OAuth callback + state/PKCE;
2. seller `/users/me` identity;
3. initial item reconciliation;
4. recent order import;
5. recent question import;
6. private/shared account visibility;
7. access-token expiry and single-use refresh rotation;
8. scheduled and manual re-sync;
9. `/life` visibility of imported orders/questions.
