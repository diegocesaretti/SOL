-- SOL's own WhatsApp identity is an authenticated assistant interface, not an ordinary monitored source.
-- Keep exactly one assistant WhatsApp account per household while allowing many normal WhatsApp sources.
CREATE UNIQUE INDEX source_accounts_one_sol_whatsapp_per_household_idx
  ON source_accounts(household_id)
  WHERE provider = 'whatsapp' AND auth_mode = 'linked-device-assistant';

CREATE TABLE sol_whatsapp_member_bindings (
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  primary_jid text,
  alternate_jid text,
  verification_hash text,
  verification_expires_at timestamptz,
  verified_at timestamptz,
  disabled_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_account_id, member_id)
);
CREATE UNIQUE INDEX sol_whatsapp_binding_primary_jid_idx
  ON sol_whatsapp_member_bindings(source_account_id, primary_jid)
  WHERE primary_jid IS NOT NULL AND disabled_at IS NULL;
CREATE UNIQUE INDEX sol_whatsapp_binding_alternate_jid_idx
  ON sol_whatsapp_member_bindings(source_account_id, alternate_jid)
  WHERE alternate_jid IS NOT NULL AND disabled_at IS NULL;
CREATE INDEX sol_whatsapp_binding_verification_idx
  ON sol_whatsapp_member_bindings(source_account_id, verification_hash)
  WHERE verification_hash IS NOT NULL AND verified_at IS NULL;

-- Conversation state is deliberately tiny and deterministic. It lets a member answer
-- "sí" / "no" to the proposal SOL most recently asked them about without handing
-- conversation authority to an LLM.
CREATE TABLE sol_whatsapp_member_state (
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  last_proposal_id uuid REFERENCES executive_proposals(id) ON DELETE SET NULL,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_account_id, member_id)
);

-- Authenticated assistant conversations have their own audit trail. Unknown senders are
-- not persisted here; they remain untrusted and cannot create commands or AI context.
CREATE TABLE sol_whatsapp_interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  jid text NOT NULL,
  body_text text NOT NULL,
  intent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sol_whatsapp_interactions_member_time_idx
  ON sol_whatsapp_interactions(member_id, created_at DESC);

-- Proposal/brief delivery is event-driven. The durable outbox remains the source of truth;
-- WhatsApp delivery can be retried independently without changing executive semantics.
CREATE OR REPLACE FUNCTION sol_emit_executive_proposal_created()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO event_outbox(
    household_id, event_type, aggregate_type, aggregate_id, payload
  ) VALUES (
    NEW.household_id,
    'executive.proposal.created',
    'executive_proposal',
    NEW.id,
    jsonb_build_object(
      'proposalId', NEW.id,
      'ownerMemberId', NEW.owner_member_id,
      'kind', NEW.kind::text
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS executive_proposal_created_outbox_trigger ON executive_proposals;
CREATE TRIGGER executive_proposal_created_outbox_trigger
AFTER INSERT ON executive_proposals
FOR EACH ROW
EXECUTE FUNCTION sol_emit_executive_proposal_created();

CREATE OR REPLACE FUNCTION sol_emit_executive_brief_created()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO event_outbox(
    household_id, event_type, aggregate_type, aggregate_id, payload
  ) VALUES (
    NEW.household_id,
    'executive.brief.created',
    'executive_brief',
    NEW.id,
    jsonb_build_object(
      'briefId', NEW.id,
      'memberId', NEW.member_id,
      'briefType', NEW.brief_type
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS executive_brief_created_outbox_trigger ON executive_briefs;
CREATE TRIGGER executive_brief_created_outbox_trigger
AFTER INSERT ON executive_briefs
FOR EACH ROW
EXECUTE FUNCTION sol_emit_executive_brief_created();
