-- An optional, owner-triggered editorial revision preserves existing
-- scheduled and manual editions rather than overwriting historical reports.
ALTER TABLE panorama_daily_editions
  DROP CONSTRAINT IF EXISTS panorama_daily_editions_slot_check;
ALTER TABLE panorama_daily_editions
  ADD CONSTRAINT panorama_daily_editions_slot_check
  CHECK (slot IN ('08','12','18','manual','review'));
