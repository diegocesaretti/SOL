# Gmail Input

Gmail is an **Input** in SOL. It contributes email observations to Life and later Knowledge; it is not an email client and it has no write authority.

```text
Gmail
  ↓ OAuth (gmail.readonly)
messages.list → messages.get
  ↓
source_items(kind=email)
conversations(kind=email_thread)
email identities
  ↓
Life
  ↓
Knowledge consolidation
  ↓
MCP
```

## Permissions

SOL requests only:

```text
https://www.googleapis.com/auth/gmail.readonly
```

The v0.10 connector does **not**:

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

The first version intentionally avoids downloading an entire mailbox at once.

Initial connection:

```text
query: newer_than:90d
maximum IDs considered: 500
```

Subsequent sync:

```text
query: newer_than:2d
maximum IDs considered: 300
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
- snippet fallback when no inline body text is available.

SOL also creates/reuses:

- an `email_thread` conversation;
- an `email` identity for the sender;
- the generic `messages` link used by SOL's communication model.

Privacy follows the source account:

```text
personal Gmail → private source items owned by that member
family Gmail   → family source items
```

## MIME / attachments

v0.10 extracts inline `text/plain` first and falls back to readable `text/html`. Body text is bounded before storage.

Attachments and binary MIME parts are **not downloaded yet**. A future attachment pipeline should store provenance/metadata first, then selectively materialize/transcribe supported attachments without making raw binary ingestion mandatory.

## Life and Knowledge

Every imported email is visible in Life immediately, subject to the member privacy boundary. It does not need to pass an AI relevance filter to exist in Life.

Unstructured email text can later participate in the same Life → Knowledge consolidator used by other text-bearing Inputs. Codex remains optional enrichment; Gmail synchronization itself does not require Codex.

## Current limitations / next steps

- Gmail push/watch notifications are not implemented; synchronization is scheduled/polling.
- Full historical mailbox import is not implemented.
- Attachments are not imported.
- Thread-aware quoting/signature stripping can be improved.
- Deterministic rules for invoices, reservations and structured notifications are future work.
- Gmail is Input-only. Any future email sending capability belongs under **Outputs** with separate scopes, explicit policy and auditing.
