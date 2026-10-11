import assert from "node:assert/strict";
import test from "node:test";
import { sourceCopySelection } from "./copy-values.js";

test("copies JSON arrays and scalars as raw text instead of driver-parsed JS arrays", () => {
  assert.equal(sourceCopySelection([
    { column_name: "id", udt_name: "uuid" },
    { column_name: "payload", udt_name: "jsonb" },
    { column_name: "metadata", udt_name: "json" },
  ]), '"id", "payload"::text AS "payload", "metadata"::text AS "metadata"');
});

test("preserves native PostgreSQL arrays and safely quotes identifiers", () => {
  assert.equal(sourceCopySelection([
    { column_name: "tags", udt_name: "_text" },
    { column_name: 'json"data', udt_name: "jsonb" },
  ]), '"tags", "json""data"::text AS "json""data"');
});
