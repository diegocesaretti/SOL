import assert from "node:assert/strict";
import test from "node:test";
import { normalizePostgresConnectionString } from "./postgres-url.js";

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
