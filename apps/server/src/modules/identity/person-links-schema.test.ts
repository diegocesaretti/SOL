import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migrationUrl = new URL(
  "../../../../../packages/database/migrations/0023_canonical_person_identity_links.sql",
  import.meta.url,
);

const migration = readFileSync(migrationUrl, "utf8");

test("canonical Person schema allows many identities per Person", () => {
  assert.match(migration, /DROP CONSTRAINT IF EXISTS identity_entity_links_entity_id_key/i);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS identity_entity_links_entity_idx\s+ON identity_entity_links\(entity_id\)/i);
  assert.doesNotMatch(migration, /CREATE\s+UNIQUE\s+INDEX[^;]*identity_entity_links[^;]*entity_id/i);
});

test("identity remains the one-to-one side of the link", () => {
  assert.doesNotMatch(migration, /DROP CONSTRAINT IF EXISTS identity_entity_links_pkey/i);
});
