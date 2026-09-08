import { migrateDatabase } from "./migration-runner.js";

// Core features and plugins may depend on schema introduced by a newer SOL build.
// ESM waits for this top-level await before evaluating the rest of index.ts, so SOL
// never starts against a partially upgraded database.
await migrateDatabase();
