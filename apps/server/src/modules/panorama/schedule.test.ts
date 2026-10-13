import assert from "node:assert/strict";
import { test } from "node:test";
import { scheduledPanoramaHours, panoramaSchedulePayload, validPanoramaInterval } from "./schedule.js";

test("default calendar stays 08, 12, 18 until explicitly changed", () => {
  assert.deepEqual(scheduledPanoramaHours(null), [8,12,18]);
  assert.equal(panoramaSchedulePayload(null).defaultSchedule,true);
});
test("configurable editorial interval fits local daylight window", () => {
  assert.deepEqual(scheduledPanoramaHours(2),[8,10,12,14,16,18,20]);
  assert.deepEqual(scheduledPanoramaHours(3),[8,11,14,17,20]);
  assert.deepEqual(scheduledPanoramaHours(4),[8,12,16,20]);
  assert.deepEqual(scheduledPanoramaHours(6),[8,14,20]);
  assert.deepEqual(scheduledPanoramaHours(12),[8,20]);
  assert.equal(validPanoramaInterval(1),false);
  assert.equal(validPanoramaInterval("4"),false);
  assert.equal(validPanoramaInterval(null),true);
});
