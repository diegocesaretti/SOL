# SOL + WhatsApp

WhatsApp is SOL's first external life-data source. The connector is intentionally designed as **multi-account and family-aware** from day one.

## Adapter

SOL uses Baileys 7 as a linked-device client. Baileys is unofficial and may need maintenance when WhatsApp changes its web protocol. SOL pins the connector version instead of silently floating to arbitrary releases.

The connector is for ingesting the household's own received/sent conversations into SOL. It must not be used for spam, bulk unsolicited messaging, stalking or bypassing WhatsApp controls.

## One source account per WhatsApp identity

```text
Household
├── Diego
│   ├── WhatsApp personal  → source_account A
│   └── WhatsApp BWA       → source_account B
├── Mariana
│   └── WhatsApp personal  → source_account C
└── Household shared
    └── WhatsApp familiar  → source_account D
```

Each account gets a completely separate Baileys authentication state and runtime socket.

Personal accounts produce `private` source records owned by their member. Shared household accounts produce `family` records. An owner/admin does **not** automatically gain read/link/logout access to another member's private WhatsApp account.

## Authentication storage

SOL does not use Baileys `useMultiFileAuthState()` in production-style operation. Instead:

```text
Baileys AuthenticationState
        │
        ├── creds
        └── Signal keys
                 │
                 ▼
          AES-256-GCM
                 │
                 ▼
            PostgreSQL
```

The encryption key lives at:

```text
.sol/secrets/whatsapp-auth.key
```

and is never stored in PostgreSQL or Git. Backups must include this key together with the database; losing it makes the encrypted linked-device credentials unrecoverable.

QR strings and pairing codes are runtime-only and are not persisted or logged.

## Connection diagnostics

Every manageable WhatsApp source account has a **Diagnóstico / logs de conexión** panel in `/whatsapp`.

The diagnostic buffer records safe lifecycle information such as:

- account creation;
- manual connect/restart requests;
- runtime state transitions (`idle`, `connecting`, `qr`, `open`, `reconnecting`, `error`, `logged_out`);
- reconnect attempt count;
- pairing-code success/failure;
- unlink requests;
- exact connection errors returned through the SOL API;
- Node/platform/architecture and persisted WhatsApp session timestamps.

The diagnostic layer deliberately does **not** accept likely secret/payload fields such as OAuth/auth tokens, credentials, QR strings or message bodies. It is an in-memory ring buffer capped per account and is cleared when SOL restarts. This is intentional: the normal debug path should not create a second persistent store of sensitive WhatsApp data.

The UI can copy the sanitized diagnostic text for troubleshooting and can clear/refresh it. Account managers only can access the diagnostic endpoint; another member's private account logs remain unavailable.

## Ingestion

SOL listens to:

- `messages.upsert`
- `messaging-history.set`
- `messaging-history.status`
- chat metadata updates
- connection/credential changes

Every account has a sequential ingestion chain so overlapping Baileys events cannot race each other inside one account. Different WhatsApp accounts can ingest concurrently.

Messages are normalized into SOL's existing model:

```text
WhatsApp message
      │
      ▼
source_items
      │
      ├── messages
      ├── conversation
      ├── identities
      └── whatsapp_message_index
```

`source_account + remote_jid + message_id` provides WhatsApp-specific idempotency, while `source_items` remains provider-neutral.

SOL stores useful text/captions and protocol metadata needed for provenance. It does not persist the complete decrypted Baileys message object by default.

## History strategy

`syncFullHistory` is requested and any history supplied by the companion protocol is stored. Historical sync is **best effort**, not a guarantee that every message ever present in the primary phone will be delivered.

History and realtime messages share the same IDs, so receiving a message through more than one sync path does not create duplicate life records.

Crucially, historical candidates do **not** immediately trigger Codex. They remain pending for future quota-aware batch consolidation. This prevents linking an old account from consuming large amounts of AI quota in one burst.

## Local candidate gate

Ordinary chat never goes directly to Codex.

```text
500 WhatsApp messages
        │
        ▼
 local deterministic filter
        │
  ┌─────┴──────────────┐
  │                    │
trivial              candidate
stored only          stored + extraction candidate
                       │
                       ▼
                 realtime only
                       │
                       ▼
                     Codex
```

The local gate looks for combinations of date/time, commitments, tasks, deadlines and event language. A weak signal such as `mañana?` or `dale 👍` is not enough by itself.

## AI extraction

A realtime candidate produces `whatsapp.candidate.detected`. The durable outbox delivers it to the candidate processor, which asks `CodexProvider` for a restricted JSON classification:

```text
kind
confidence
title
summary
dateTime
dueAt
participants
needsConfirmation
notes
```

At Phase 3 this **does not create Calendar events or tasks**. It only creates structured knowledge candidates. The executive/action layer is intentionally separate and comes next.

All WhatsApp content passed to Codex is explicitly marked as untrusted source data. A message saying `ignore previous instructions...` has no authority to grant itself SOL capabilities.

## UI

After logging into SOL:

```text
http://127.0.0.1:3000/whatsapp
```

From this screen an authorized member can:

- create personal WhatsApp source accounts;
- create shared household accounts when their role allows it;
- link with QR;
- request a pairing code;
- see connection/reconnection status;
- inspect/copy safe connection diagnostics;
- unlink their account;
- inspect recent stored messages they are authorized to read.

Connection buttons surface the exact API error inline instead of discarding the response during a page refresh. This makes QR/pairing/socket failures directly actionable from the diagnostic panel.

## Privacy / E2EE boundary

WhatsApp encrypts traffic to linked devices. Once SOL, as a linked endpoint, decrypts a message and persists it locally or sends a selected candidate to Codex, that copy is outside WhatsApp's end-to-end-encrypted transport envelope. SOL therefore minimizes cloud processing: raw ordinary traffic remains local and only locally selected candidates are sent to the reasoning engine.
