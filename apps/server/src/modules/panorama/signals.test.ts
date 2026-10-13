import assert from "node:assert/strict";
import { test } from "node:test";
import { publishPanoramaEdition, subscribePanoramaEditions } from "./signals.js";

test("Panorama publishes committed edition IDs without exposing narrative", () => {
  const received: unknown[] = [];
  const close=subscribePanoramaEditions(e=>received.push(e));
  const msg={householdId:"house-1",memberId:"person-1",editionId:"edition-1",createdAt:"2026-10-12T20:00:00Z"};
  publishPanoramaEdition(msg);
  assert.deepEqual(received,[msg]);
  close();
  publishPanoramaEdition({...msg,editionId:"edition-2"});
  assert.equal(received.length,1);
});
