import assert from "node:assert/strict";
import test from "node:test";
import { haOnlyDelayMs } from "../lib/stremio-ha-only-timing.mjs";

test("HA-only Stremio click waits at least eight seconds", () => {
  assert.equal(haOnlyDelayMs({}), 8000);
  assert.equal(haOnlyDelayMs({ HA_SOL_STREMIO_FIRST_STREAM_DELAY_MS: "3500" }), 8000);
  assert.equal(haOnlyDelayMs({ HA_SOL_STREMIO_FIRST_STREAM_DELAY_MS: "12000" }), 12000);
});
