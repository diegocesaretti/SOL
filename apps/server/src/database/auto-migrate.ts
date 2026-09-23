import { initializeCloudSync } from "./cloud-sync.js";
import { migrateDatabase } from "./migration-runner.js";

// Core features and plugins may depend on schema introduced by a newer SOL build.
// In hybrid mode the active database is the embedded local PostgreSQL instance.
// It is migrated first, then safely seeded from Neon when a cloud copy is available.
await migrateDatabase();
await initializeCloudSync();
