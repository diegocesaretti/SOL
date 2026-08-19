# SOL on Windows without Docker

SOL's default target-host profile is now **native Windows**. Docker Desktop, WSL, Hyper-V, Redis and pgvector are not required.

## Runtime layout

```text
Windows
├── SOL Core (Node.js / TypeScript)
├── Codex CLI / App Server
├── WhatsApp linked-device sessions
├── Google OAuth / Calendar
└── PostgreSQL Windows service
```

Future connectors such as SOL's own WhatsApp identity, Home Assistant and Mercado Libre use the same SOL Core process and PostgreSQL database; they do not require containers.

## Requirements

- Windows 10/11 or comparable supported Windows host
- Node.js 22+ (24 recommended)
- pnpm
- PostgreSQL 18/17/16 native Windows installation
- Codex CLI only if the Codex reasoning engine is enabled

Use the normal PostgreSQL Windows installer. The default port `5432` is fine. Remember the password chosen for the PostgreSQL administrator account (`postgres`). pgAdmin is optional.

The SOL setup helper looks for `psql.exe` in PATH and common PostgreSQL install directories, so adding PostgreSQL to PATH is optional.

## First setup

From the repository root:

```powershell
pnpm install
pnpm db:setup
pnpm db:check
pnpm db:migrate
pnpm dev
```

`pnpm db:setup`:

1. finds the native `psql.exe`;
2. connects as the local PostgreSQL administrator;
3. creates (or updates) the dedicated `sol` login;
4. creates the `sol` database if needed;
5. generates a random application database password;
6. writes `DATABASE_URL` to the Git-ignored `.env` file.

The administrator password is entered directly into `psql`; SOL does not store it.

## Daily startup

PostgreSQL is expected to run as a normal Windows service. SOL itself remains a normal Node process during development:

```powershell
pnpm db:check
pnpm dev
```

Later, for an always-on household installation, SOL Core can itself be registered as a Windows service without changing the database architecture.

## Database configuration

SOL depends only on a PostgreSQL connection string:

```dotenv
DATABASE_URL=postgresql://sol:<generated-password>@127.0.0.1:5432/sol
```

The application does not care whether PostgreSQL is Windows-native, Linux-native or remote. Windows-native is simply the preferred installation for the current target host.

## Why Redis was removed

No current SOL module uses Redis. Durable events, scheduler state, sessions, synchronization cursors, proposals and source state already live in PostgreSQL. Adding Redis before a demonstrated need would add another service without providing current value.

If a future workload proves it useful, it can be introduced behind an internal abstraction without changing the domain model.

## Why pgvector is optional

Semantic embeddings are not canonical memory and no current SOL flow requires vector search. The original base schema reserved a pgvector table, but that made a fresh Windows installation depend on an external PostgreSQL extension for no current benefit.

The base schema now uses standard PostgreSQL only. When semantic retrieval is implemented, SOL can add pgvector through a dedicated optional migration/profile. Existing structured Life, Knowledge and Executive data does not depend on it.

## Backups

A useful SOL backup must eventually include:

- the PostgreSQL database;
- `.sol/secrets/whatsapp-auth.key` if WhatsApp linked-device credentials are to be restored;
- `.sol/secrets/google-oauth.key` if Google credentials are to be restored;
- the dedicated `.sol/codex` profile if preserving the SOL Codex login is desired.

Do not commit any of these secrets to Git.
