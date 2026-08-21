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

CREATE OR REPLACE FUNCTION enqueue_executive_proposal_created()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Historical bootstrap candidates are intentionally batched into briefs/pending lists
  -- instead of generating one WhatsApp notification per recovered item.
  IF NEW.source_candidate_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM extraction_candidates ec
    WHERE ec.id = NEW.source_candidate_id
      AND ec.reasons @> '["historical-bootstrap"]'::jsonb
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO event_outbox(
    household_id, event_type, aggregate_type, aggregate_id, payload
  ) VALUES (
    NEW.household_id,
    'executive.proposal.created',
    'executive_proposal',
    NEW.id,
    jsonb_build_object(
      'proposalId', NEW.id,
      'ownerMemberId', NEW.owner_member_id
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS executive_proposal_created_outbox ON executive_proposals;
CREATE TRIGGER executive_proposal_created_outbox
AFTER INSERT ON executive_proposals
FOR EACH ROW
EXECUTE FUNCTION enqueue_executive_proposal_created();
