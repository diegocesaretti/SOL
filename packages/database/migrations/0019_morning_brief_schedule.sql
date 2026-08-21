ALTER TABLE member_proactivity_settings ALTER COLUMN morning_time SET DEFAULT '08:00';
UPDATE member_proactivity_settings SET morning_time='08:00' WHERE morning_time='07:30';
