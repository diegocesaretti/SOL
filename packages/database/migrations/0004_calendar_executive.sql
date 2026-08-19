CREATE TYPE executive_proposal_status AS ENUM ('pending', 'approved', 'rejected', 'executing', 'executed', 'failed');
CREATE TYPE executive_proposal_kind AS ENUM ('task', 'event', 'commitment', 'deadline', 'information');

-- One encrypted OAuth credential set per Google Calendar source account.
CREATE TABLE google_oauth_credentials (
  source_account_id uuid PRIMARY KEY REFERENCES source_accounts(id) ON DELETE CASCADE,
  encrypted_payload text NOT NULL,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  google_account_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Short-lived OAuth state is persisted so callback validation survives a server restart.
CREATE TABLE google_oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  state_hash text NOT NULL UNIQUE,
  code_verifier text NOT NULL,
  redirect_after text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX google_oauth_states_expiry_idx ON google_oauth_states(expires_at);

-- A Google account may expose several calendars. Selection is explicit and independent
-- for reading and writing so SOL can read family/personal calendars without accidentally
-- choosing the wrong destination for actions.
CREATE TABLE google_calendars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  external_calendar_id text NOT NULL,
  summary text NOT NULL,
  timezone text,
  access_role text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  selected_for_sync boolean NOT NULL DEFAULT false,
  selected_for_write boolean NOT NULL DEFAULT false,
  sync_token text,
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_account_id, external_calendar_id)
);
CREATE INDEX google_calendars_source_idx ON google_calendars(source_account_id);
CREATE INDEX google_calendars_sync_idx ON google_calendars(source_account_id, selected_for_sync);

CREATE TABLE google_event_links (
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  google_calendar_id uuid NOT NULL REFERENCES google_calendars(id) ON DELETE CASCADE,
  external_event_id text NOT NULL,
  source_item_id uuid NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  life_event_id uuid REFERENCES life_events(id) ON DELETE SET NULL,
  etag text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_account_id, google_calendar_id, external_event_id),
  UNIQUE(source_item_id)
);
CREATE INDEX google_event_links_life_idx ON google_event_links(life_event_id);

-- This is the safety boundary between knowledge and action. Candidate extraction may
-- create proposals automatically; external writes require an explicit proposal decision.
CREATE TABLE executive_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  source_candidate_id uuid UNIQUE REFERENCES extraction_candidates(id) ON DELETE SET NULL,
  source_item_id uuid REFERENCES source_items(id) ON DELETE SET NULL,
  kind executive_proposal_kind NOT NULL,
  status executive_proposal_status NOT NULL DEFAULT 'pending',
  title text NOT NULL,
  summary text,
  starts_at timestamptz,
  due_at timestamptz,
  visibility visibility_scope NOT NULL DEFAULT 'private',
  confidence real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_source_account_id uuid REFERENCES source_accounts(id) ON DELETE SET NULL,
  target_google_calendar_id uuid REFERENCES google_calendars(id) ON DELETE SET NULL,
  decided_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  decided_at timestamptz,
  executed_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX executive_proposals_household_status_idx
  ON executive_proposals(household_id, status, created_at DESC);
CREATE INDEX executive_proposals_owner_status_idx
  ON executive_proposals(owner_member_id, status, created_at DESC);

-- Briefs are persisted so delivery channels (SOL WhatsApp, voice, web, future push)
-- can all reuse the same prepared content without recomputing it independently.
CREATE TABLE executive_briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  member_id uuid REFERENCES members(id) ON DELETE CASCADE,
  brief_type text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id, member_id, brief_type, period_start, period_end)
);
