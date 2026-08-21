import assert from "node:assert/strict";
import test from "node:test";
import { clockMinutes, localMinuteOfDay, scheduleWindowOpen } from "./scheduler.js";

test("parses proactive clock values", () => {
  assert.equal(clockMinutes("07:30"), 450);
  assert.equal(clockMinutes("20:30"), 1230);
});

test("evaluates proactive windows in the member timezone", () => {
  const morning = new Date("2026-08-20T10:45:00Z");
  assert.equal(localMinuteOfDay(morning, "America/Argentina/Buenos_Aires"), 465);
  assert.equal(
    scheduleWindowOpen(morning, "America/Argentina/Buenos_Aires", "07:30"),
    true,
  );

  const tooEarly = new Date("2026-08-20T10:20:00Z");
  assert.equal(
    scheduleWindowOpen(tooEarly, "America/Argentina/Buenos_Aires", "07:30"),
    false,
  );

  const evening = new Date("2026-08-20T23:45:00Z");
  assert.equal(
    scheduleWindowOpen(evening, "America/Argentina/Buenos_Aires", "20:30"),
    true,
  );
});
