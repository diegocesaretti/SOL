import assert from "node:assert/strict";
import test from "node:test";
import { zonedDayRange } from "./briefs.js";

test("Buenos Aires day range uses local midnight", () => {
  const now = new Date("2026-08-19T17:30:00.000Z"); // 14:30 in Buenos Aires
  const range = zonedDayRange("America/Argentina/Buenos_Aires", 0, now);
  assert.equal(range.start.toISOString(), "2026-08-19T03:00:00.000Z");
  assert.equal(range.end.toISOString(), "2026-08-20T03:00:00.000Z");
});

test("tomorrow preview advances one local calendar day", () => {
  const now = new Date("2026-08-19T17:30:00.000Z");
  const range = zonedDayRange("America/Argentina/Buenos_Aires", 1, now);
  assert.equal(range.start.toISOString(), "2026-08-20T03:00:00.000Z");
  assert.equal(range.end.toISOString(), "2026-08-21T03:00:00.000Z");
});

test("day range follows timezone offset changes rather than assuming 24 hours", () => {
  const now = new Date("2026-11-01T12:00:00.000Z");
  const range = zonedDayRange("America/New_York", 0, now);
  assert.equal(range.start.toISOString(), "2026-11-01T04:00:00.000Z");
  assert.equal(range.end.toISOString(), "2026-11-02T05:00:00.000Z");
});
