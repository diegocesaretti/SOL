-- Persist member-scoped incremental daily narratives. Each edition is immutable by slot.
CREATE TABLE IF NOT EXISTS panorama_daily_editions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  local_date date NOT NULL,
  slot text NOT NULL CHECK(slot IN ('08','12','18','manual')),
  as_of timestamptz NOT NULL,
  timezone text NOT NULL,
  narrative text NOT NULL,
  provider text NOT NULL,
  source_stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  event_count integer NOT NULL DEFAULT 0,
  new_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id, member_id, local_date, slot)
);
CREATE INDEX IF NOT EXISTS panorama_daily_editions_member_date_idx
  ON panorama_daily_editions(household_id, member_id, local_date DESC, as_of DESC);
