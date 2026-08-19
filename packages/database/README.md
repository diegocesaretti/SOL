# SOL database

PostgreSQL is SOL's system of record. `pgvector` is enabled in the initial migration but vector search is deliberately secondary to structured data.

For a fresh development database, Docker mounts `migrations/0001_initial.sql` into PostgreSQL initialization.

For existing installations, future migrations must be applied by an explicit migration runner rather than editing `0001_initial.sql` in place.
