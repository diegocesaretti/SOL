CREATE UNIQUE INDEX google_calendars_single_write_target_idx
  ON google_calendars(source_account_id)
  WHERE selected_for_write = true;
