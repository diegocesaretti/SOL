ALTER TABLE executive_briefs
  ADD COLUMN IF NOT EXISTS delivery_requested_at timestamptz;

CREATE TABLE IF NOT EXISTS member_proactivity_settings (
  member_id uuid PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  morning_brief_enabled boolean NOT NULL DEFAULT true,
  morning_time time NOT NULL DEFAULT '07:30',
  tomorrow_preview_enabled boolean NOT NULL DEFAULT true,
  tomorrow_time time NOT NULL DEFAULT '20:30',
  suppress_empty boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE member_proactivity_settings IS
  'Per-member proactive delivery preferences. Times are interpreted in the member/household timezone.';

COMMENT ON COLUMN executive_briefs.delivery_requested_at IS
  'Set once the proactive scheduler has handled delivery for this brief, including intentional empty-brief suppression.';
