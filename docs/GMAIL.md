# Gmail Input

Gmail is an **Input** in SOL. It contributes email observations to Life and later processing; it is not an email client and it has no write authority.

```text
Gmail
  ↓ OAuth (gmail.readonly)
messages.list → messages.get
  ↓
source_items(kind=email)
conversations(kind=email_thread)
email identities
  ↓
Life  ← always preserved
  ↓
Deterministic Intelligence Gate
  ├─ operational → optional AI classification → Executive proposal
  ├─ knowledge   → sparse Knowledge consolidation
  └─ neither     → Life only; no LLM quota
  ↓
MCP / Outputs as separately authorized
```

## Permissions

SOL requests only:

```text
https://www.googleapis.com/auth/gmail.readonly
```

The connector does **not**:

- send mail;
- delete mail;
- mark mail read/unread;
- modify labels;
- archive or move mail.

Credentials are stored encrypted. The clear refresh/access token is never stored in `source_items` or exposed through Inputs/MCP.

## Google Cloud setup

1. Enable the Gmail API in the Google Cloud project used by SOL.
2. Use an OAuth 2.0 **Web application** client.
3. Register this redirect URI exactly:

```text
http://127.0.0.1:3000/v1/gmail/callback
```

4. Configure the OAuth consent screen/test users as required by your Google Cloud project.

Gmail may reuse the same OAuth client used by Google Calendar. In that case these existing variables are enough:

```dotenv
SOL_GOOGLE_CLIENT_ID=...
SOL_GOOGLE_CLIENT_SECRET=...
```

and SOL will use the Gmail callback above. A separate OAuth client is also supported:

```dotenv
SOL_GMAIL_CLIENT_ID=...
SOL_GMAIL_CLIENT_SECRET=...
SOL_GMAIL_REDIRECT_URI=http://127.0.0.1:3000/v1/gmail/callback
```

## Synchronization policy

SOL intentionally avoids downloading an entire mailbox at once.

Initial connection:

```text
query: newer_than:90d
maximum IDs considered: 500
origin: history
```

Subsequent sync:

```text
query: newer_than:2d
maximum IDs considered: 300
origin: realtime
```

Default scheduler interval:

```dotenv
SOL_GMAIL_SYNC_MS=900000
```

Manual sync is available from **Inputs**.

Messages are deduplicated using Gmail's stable message ID through the generic SOL `source_items` uniqueness boundary.

## What is stored

For each imported email SOL records a provenance-bearing source item containing:

- Gmail message/thread IDs;
- subject;
- From / To / CC metadata;
- received/internal timestamp;
- label IDs;
- readable text body when available;
- snippet fallback when no inline body text is available;
- selected mail headers used by the deterministic gate (`List-Unsubscribe`, `Precedence`, `Auto-Submitted`);
- Intelligence Gate score, routes, priority and reasons.

SOL also creates/reuses:

- an `email_thread` conversation;
- an `email` identity for the sender;
- the generic `messages` link used by SOL's communication model.

Privacy follows the source account:

```text
personal Gmail → private source items owned by that member
family Gmail   → family source items
```

## Intelligence Gate

Every email is preserved in Life first. Passing or failing the gate never decides whether the original observation exists.

The gate is deterministic and local. It looks at signals such as:

- dates, times, deadlines, commitments, reservations and money;
- durable preferences, routines, relationships, projects and recurring details;
- `IMPORTANT` / `STARRED` labels;
- replies/forwards and human-like correspondence;
- promotions, newsletters, bulk headers, no-reply/automated senders and security-code noise.

It produces two independent routes:

```text
operational → task/event/commitment/deadline classification
knowledge   → durable entity/fact consolidation
```

Items with neither route remain available in Life but are marked `ignored` for Knowledge consolidation, so they do not repeatedly consume LLM quota.

Only **new Gmail sync traffic** (`origin=realtime`) creates operational extraction candidates. The initial 90-day import is treated as history so connecting a mailbox cannot suddenly generate hundreds of old proposals or AI calls.

If the optional AI provider is unavailable, ingestion and the gate continue normally. Eligible work stays deferred; Gmail itself never depends on the LLM.

## MIME / attachments

SOL extracts inline `text/plain` first and falls back to readable `text/html`. Body text is bounded before storage.

Attachments and binary MIME parts are **not downloaded yet**. A future attachment pipeline should store provenance/metadata first, then selectively materialize/transcribe supported attachments without making raw binary ingestion mandatory.

## Life and Knowledge

Every imported email is visible in Life immediately, subject to the member privacy boundary. Life presents long bodies as a compact preview with **Ver más** rather than turning the timeline into an inbox clone.

Only items routed to `knowledge` are eligible for the LLM Knowledge consolidator. The consolidator still validates evidence IDs and confidence before writing durable entities/facts.

## Current limitations / next steps

- Gmail push/watch notifications are not implemented; synchronization is scheduled/polling.
- Full historical mailbox import is not implemented.
- Attachments are not imported.
- Thread-aware quoted-text/signature stripping can be improved.
- Gate rules should be tuned with real mailbox examples and false-positive/false-negative telemetry.
- Gmail is Input-only. Any future email sending capability belongs under **Outputs** with separate scopes, explicit policy and auditing.
