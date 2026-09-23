# SOL on Windows without Docker

SOL Full runs natively on Windows. Docker Desktop, WSL, Hyper-V, Redis and pgvector are not required.

Starting with SOL Full 0.16, the standard Windows package includes its own PostgreSQL runtime. The database cluster is persistent under the SOL data directory and is not replaced by application updates.

## Default SOL Full layout

```text
Windows
├── SOL.exe
├── SOL Core (Node.js / TypeScript)
├── embedded PostgreSQL
│   └── %LOCALAPPDATA%\SOL\postgres
├── Nexo / WhatsApp plugin
├── Codex Audio Remote plugin
├── Home Assistant plugin
└── Neon PostgreSQL (optional cloud replica / initial seed)
```

The local PostgreSQL server binds only to `127.0.0.1`. SOL generates and stores a dedicated local database password in the persistent data directory.

## Normal Windows setup

Use the published `SOL-Windows.zip`. No separate PostgreSQL installation is required.

On first start, the launcher creates the persistent SOL configuration under `%LOCALAPPDATA%\SOL`. If you are upgrading an existing Neon-backed SOL installation, keep the real Neon URL in:

```dotenv
DATABASE_URL=postgresql://...
```

SOL uses that connection once to seed the local database, then keeps Neon as a batched cloud replica. After the first successful seed, SOL can start while Neon or the internet is unavailable.

## Development

For a local-only checkout:

```powershell
pnpm install
$env:SOL_CLOUD_SYNC="false"
pnpm db:check
pnpm db:migrate
pnpm dev
```

The default embedded cluster uses port `55432`. It can be changed with:

```dotenv
SOL_LOCAL_DB_PORT=55432
```

## External local PostgreSQL override

The bundled database is the normal profile. Advanced installations may still use an already-installed PostgreSQL server instead.

Run:

```powershell
pnpm db:setup
```

The helper creates the `sol` role/database and writes:

```dotenv
SOL_LOCAL_DATABASE_URL=postgresql://sol:<generated-password>@127.0.0.1:5432/sol
```

That setting disables the managed embedded cluster and makes the supplied PostgreSQL instance SOL's local runtime authority.

`DATABASE_URL` remains independently available for Neon cloud replication.

## Database commands

`pnpm db:check` verifies the local runtime database, not Neon.

`pnpm db:migrate` applies SOL migrations to the local runtime database. Normal SOL startup also migrates the local database automatically.

Cloud schema migrations are applied by the cloud replicator when Neon is reachable.

## Updates and persistence

The portable application files can be replaced by `SOL.Updater.exe`, but the following state remains under the persistent SOL data root:

- embedded PostgreSQL cluster and local DB credentials;
- plugin data and linked-device sessions;
- Codex profile/workspace;
- the persistent `.env`;
- logs and update state.

This lets the Full updater replace application binaries without replacing household data.

## Backups

A complete local-first backup should include the persistent SOL data directory, especially:

- `postgres\` for the local PostgreSQL authority;
- plugin data/session directories;
- credential/secrets files;
- the persistent `.env`;
- the dedicated Codex profile if its login/workspace must be preserved.

Neon is an additional cloud copy, not a substitute for validating local backups.
