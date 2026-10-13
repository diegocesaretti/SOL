-- Optional member-scoped cadence for the daily Panorama journal.
-- NULL preserves the original editorial moments (08:00, 12:00, 18:00).
CREATE TABLE IF NOT EXISTS panorama_schedule_preferences (
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  interval_hours integer NULL CHECK (interval_hours IN (2,3,4,6,12)),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(household_id, member_id)
);

ALTER TABLE panorama_daily_editions DROP CONSTRAINT IF EXISTS panorama_daily_editions_slot_check;
ALTER TABLE panorama_daily_editions
  ADD CONSTRAINT panorama_daily_editions_slot_check
  CHECK (slot IN ('manual','review') OR slot ~ '^(0[8-9]|1[0-9]|20)$');
