import assert from "node:assert/strict";
import test from "node:test";
import { normalizeScheduleSubmission } from "./submissions.js";

test("normalizes a Luca school schedule and defaults to replacement", () => {
  const schedule = normalizeScheduleSubmission({
    person: "  Luca  ",
    scheduleName: "Colegio",
    timezone: "America/Argentina/Cordoba",
    validFrom: "2026-03-02",
    validUntil: "2026-12-18",
    entries: [
      { day: "monday", start: "07:30", end: "08:50", title: "Matemática" },
      { day: "monday", start: "09:00", title: "Lengua" },
      { day: "tuesday", start: "07:30", title: "Inglés" },
    ],
  });
  assert.equal(schedule.person, "Luca");
  assert.equal(schedule.scheduleName, "Colegio");
  assert.equal(schedule.replaceExisting, true);
  assert.equal(schedule.entries.length, 3);
  assert.deepEqual(schedule.entries[0], {
    day: "monday",
    start: "07:30",
    end: "08:50",
    title: "Matemática",
    location: undefined,
    notes: undefined,
  });
});

test("rejects invalid schedule clocks and reversed validity", () => {
  assert.throws(
    () => normalizeScheduleSubmission({
      person: "Luca",
      validFrom: "2026-12-01",
      validUntil: "2026-03-01",
      entries: [{ day: "monday", start: "07:30", title: "Matemática" }],
    }),
    /validUntil/,
  );
  assert.throws(
    () => normalizeScheduleSubmission({
      person: "Luca",
      entries: [{ day: "monday", start: "25:30", title: "Matemática" }],
    }),
    /HH:MM/,
  );
  assert.throws(
    () => normalizeScheduleSubmission({
      person: "Luca",
      entries: [{ day: "monday", start: "09:00", end: "08:00", title: "Matemática" }],
    }),
    /after start/,
  );
});
