# SOL Full with Neon cloud replication

Starting with SOL Full 0.16, Neon is the cloud replica and bootstrap source, not the database on SOL's critical runtime path.

## Architecture

```text
Windows host
├── SOL Core
├── embedded PostgreSQL  ← runtime authority
│        │
│        └── durable change journal
│                 │
│                 └── batched push
│                          ↓
└────────────────────── Neon PostgreSQL
```

The permanent SOL `LISTEN/NOTIFY` connection is local. Neon is contacted only for the initial seed, pending replication batches, explicit manual sync, or recovery probes after a cloud failure.

## First seed

Keep the existing Neon connection string in the persistent SOL `.env`:

```dotenv
DATABASE_URL=postgresql://...
SOL_CLOUD_SYNC=true
```

On the first 0.16+ start SOL:

1. initializes its embedded PostgreSQL database;
2. applies the same SOL migrations locally and in Neon;
3. copies a consistent Neon snapshot to local PostgreSQL;
4. pairs both stores with a shared authority id;
5. starts SOL against the local database.

A fresh local database deliberately refuses to create a competing blank SOL household when Neon is unreachable. The first seed therefore needs one successful Neon connection.

## Normal operation

After the seed, SOL starts and accepts writes even when:

- the internet is down;
- Neon is suspended;
- Neon is experiencing an outage;
- the Neon project has exhausted its compute allowance.

Local changes are recorded in `sol_sync_changes`. The default recovery/batch interval is 30 minutes, but SOL does not wake Neon on that interval when the replica is already caught up.

```dotenv
SOL_CLOUD_SYNC_MS=1800000
SOL_CLOUD_SYNC_BATCH_SIZE=200
```

A manual authenticated sync is available through `POST /v1/system/cloud-sync`.

## Conflict policy

Replication is intentionally conservative. If Neon receives application-row writes outside SOL's cloud replicator, or if the cloud database is paired with a different local authority, automatic push stops with a `conflict` status.

SOL never resolves that condition by silently overwriting one side.

## Status

`GET /health` and `GET /v1/system` expose:

- local database health;
- `databaseMode: "local-first"`;
- cloud availability;
- pending change count;
- last successful sync;
- the last cloud error/conflict.

Local database health determines whether SOL itself is healthy. A Neon outage alone does not make SOL unhealthy.

## Compute usage

The old remote `LISTEN/NOTIFY` session could keep a scale-to-zero compute active. In 0.16+, that listener exists only on local PostgreSQL.

Cloud replication is batched and skipped entirely when there are no pending changes and the last cloud state is synchronized. This is designed to let Neon return to scale-to-zero between actual replica updates.

## Security

`DATABASE_URL` remains a password-bearing cloud credential and must never be committed.

The embedded PostgreSQL server binds to `127.0.0.1`, uses a generated local password, and stores its persistent cluster under the SOL data directory (normally `%LOCALAPPDATA%\\SOL\\postgres` on Windows).

Plugins never receive either local or Neon database credentials.
