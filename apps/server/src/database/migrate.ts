import { closeDatabase } from "./client.js";
import { migrateDatabase } from "./migration-runner.js";

migrateDatabase()
  .then(() => closeDatabase())
  .catch(async (error) => {
    console.error("Database migration failed", error);
    await closeDatabase();
    process.exitCode = 1;
  });
