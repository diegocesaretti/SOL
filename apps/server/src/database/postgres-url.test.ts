import assert from "node:assert/strict";
import test from "node:test";
import {
  directPostgresConnectionString,
  normalizePostgresConnectionString,
} from "./postgres-url.js";

test("normalizes current secure SSL aliases to verify-full", () => {
  for (const mode of ["prefer", "require", "verify-ca"]) {
    const result = normalizePostgresConnectionString(
      `postgresql://user:pass@example.neon.tech/db?sslmode=${mode}&channel_binding=require`,
    );
    const url = new URL(result);
    assert.equal(url.searchParams.get("sslmode"), "verify-full");
    assert.equal(url.searchParams.get("channel_binding"), "require");
  }
});

test("leaves explicit and non-PostgreSQL connection strings unchanged", () => {
  const explicit = "postgresql://user:pass@example.test/db?sslmode=disable";
  assert.equal(normalizePostgresConnectionString(explicit), explicit);

  const opaque = "not a url";
  assert.equal(normalizePostgresConnectionString(opaque), opaque);
});

test("derives direct Neon endpoint from pooled endpoint for session listeners", () => {
  const pooled =
    "postgresql://user:pass@ep-damp-poetry-pooler.sa-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
  const result = new URL(directPostgresConnectionString(pooled));

  assert.equal(result.hostname, "ep-damp-poetry.sa-east-1.aws.neon.tech");
  assert.equal(result.pathname, "/neondb");
  assert.equal(result.searchParams.get("sslmode"), "require");
  assert.equal(result.searchParams.get("channel_binding"), "require");
});

test("keeps non-pooled PostgreSQL endpoints unchanged for direct listeners", () => {
  const direct = "postgresql://user:pass@example.test/db?sslmode=verify-full";
  assert.equal(directPostgresConnectionString(direct), direct);

  const opaque = "not a url";
  assert.equal(directPostgresConnectionString(opaque), opaque);
});
