import assert from "node:assert/strict";
import test from "node:test";
import { parseMercadoLibreJson } from "./json.js";

test("preserves unsafe Mercado Libre integer identifiers as strings", () => {
  const parsed = parseMercadoLibreJson<{ user_id: string; safe: number; amount: number }>(
    '{"user_id":9223372036854775807,"safe":123456,"amount":1250.5}',
  );
  assert.equal(parsed.user_id, "9223372036854775807");
  assert.equal(parsed.safe, 123456);
  assert.equal(parsed.amount, 1250.5);
});

test("does not rewrite digits inside strings", () => {
  const parsed = parseMercadoLibreJson<{ item_id: string; text: string }>(
    '{"item_id":"MLA1234567890123456","text":"order 9223372036854775807"}',
  );
  assert.equal(parsed.item_id, "MLA1234567890123456");
  assert.equal(parsed.text, "order 9223372036854775807");
});
