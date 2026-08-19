# SOL with Neon PostgreSQL

Neon is the preferred database profile for the current SOL prototype. SOL remains standard-PostgreSQL compatible, so a local Windows PostgreSQL service can still be used without changing application code.

## Why this profile

```text
Windows host
├── SOL Core / Node.js
├── Codex CLI / App Server
├── WhatsApp linked-device sessions
├── Google Calendar
└── Neon PostgreSQL over TLS
```

This keeps the SOL host free of Docker, WSL, Hyper-V, Redis and a local PostgreSQL server.

## Configure the connection

Never place a real connection string in Git, README files, issues or source code. From the repository root run:

```powershell
pnpm db:configure
```

Paste the Neon PostgreSQL connection string into the hidden prompt. The helper writes it only to `.env`, which is ignored by Git.

Then verify and initialize:

```powershell
pnpm db:check
pnpm db:migrate
pnpm dev
```

`db:check` uses SOL's Node `pg` driver, so PostgreSQL client tools such as `psql.exe` are not required for Neon.

## Direct vs pooled connection

SOL currently runs as one long-lived Node process with a small connection pool. A direct Neon connection is appropriate for this profile and is preferred for schema migrations.

If SOL later grows into several stateless workers or many concurrent server processes, a pooled Neon connection can be introduced for application traffic while keeping a direct URL for migrations.

## Scale-to-zero behavior

The Free plan suspends an inactive compute after roughly five minutes. SOL therefore avoids rapid database polling:

- `event_outbox` inserts emit a PostgreSQL `NOTIFY` signal;
- short-lived pool connections `LISTEN` while they are active;
- notifications wake the in-memory outbox dispatcher immediately after commit;
- idle pool clients are released quickly;
- a slow recovery sweep catches missed notifications after crashes/restarts;
- Calendar and executive reconciliation use sparse schedules rather than constant polling.

`LISTEN` state is deliberately treated as ephemeral. If Neon suspends the compute, session state disappears; a fresh physical pool connection reinstalls `LISTEN` automatically. Durable truth remains in `event_outbox`, not in the notification itself.

Default cloud-friendly settings:

```dotenv
SOL_DB_POOL_MAX=4
SOL_DB_IDLE_TIMEOUT_MS=15000
SOL_DB_CONNECT_TIMEOUT_MS=15000
SOL_OUTBOX_RECOVERY_MS=1800000
SOL_CALENDAR_SYNC_MS=3600000
SOL_EXECUTIVE_POLL_MS=1800000
```

These are tunable but should not be reduced aggressively on a scale-to-zero database without a concrete reason.

## Security

The Neon `DATABASE_URL` is a password-bearing credential. Treat it like any other secret.

Provider credentials with especially high impact are additionally encrypted by SOL before PostgreSQL persistence:

- WhatsApp linked-device credentials / Signal keys;
- Google OAuth credentials.

Their encryption keys stay on the SOL host under `.sol/secrets/` and are never stored in Neon or Git.

For long-term use, rotate a database password if it has ever been pasted into a chat, ticket, terminal transcript or other place where it did not need to be retained.

## Storage policy

Neon should hold structured SOL state: messages/text, events, metadata, identities, tasks, proposals, knowledge and connector state.

Large blobs should remain outside PostgreSQL:

```text
Neon
├── structured records
├── text
├── metadata
└── references

Local/object storage later
├── photos
├── audio
├── videos
├── PDFs
└── attachments
```

This keeps database growth predictable and preserves the option to use inexpensive blob storage later.

## Local PostgreSQL fallback

If cloud storage is not desired, `pnpm db:setup` still provisions a native Windows PostgreSQL database and writes a local `DATABASE_URL`. The rest of SOL is unchanged.
