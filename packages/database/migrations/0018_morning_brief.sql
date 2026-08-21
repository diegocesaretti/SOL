ALTER TABLE member_proactivity_settings
  ADD COLUMN IF NOT EXISTS morning_timezone text NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  ADD COLUMN IF NOT EXISTS morning_sources jsonb NOT NULL DEFAULT '{"gmail":true,"whatsapp":true,"mercadolibre":true,"calendar":true}'::jsonb,
  ADD COLUMN IF NOT EXISTS morning_auto_create_events boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS morning_send_whatsapp boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS morning_whatsapp_grant boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS morning_max_whatsapp integer NOT NULL DEFAULT 200,
  ADD COLUMN IF NOT EXISTS morning_max_emails integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS morning_max_mercadolibre integer NOT NULL DEFAULT 100;

CREATE TABLE IF NOT EXISTS morning_brief_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  scheduled_for date NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL CHECK (status IN ('running','completed','partial','failed','preview')),
  sources_checked jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_errors jsonb NOT NULL DEFAULT '{}'::jsonb,
  events_created jsonb NOT NULL DEFAULT '[]'::jsonb,
  events_updated jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  whatsapp_message_id text,
  summary text,
  dry_run boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS morning_brief_runs_daily_once_idx
  ON morning_brief_runs(member_id, scheduled_for) WHERE dry_run = false;
CREATE INDEX IF NOT EXISTS morning_brief_runs_member_started_idx
  ON morning_brief_runs(member_id, started_at DESC);

COMMENT ON COLUMN member_proactivity_settings.morning_whatsapp_grant IS
  'Explicit proactive policy grant. Independent from interactive confirmedByUser and limited to one Morning Brief delivery per local day.';
