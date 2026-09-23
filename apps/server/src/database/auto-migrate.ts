import { db } from "./client.js";
import { initializeCloudSync } from "./cloud-sync.js";
import { migrateDatabase } from "./migration-runner.js";

// Local PostgreSQL is SOL Full's runtime authority. Migrations always run here
// before any module is evaluated. Neon is only needed once for the first seed;
// after that, cloud outages or quota exhaustion never block SOL startup.
await migrateDatabase(db, "local");
await initializeCloudSync();
