ALTER TABLE members
  ADD COLUMN login_name text;

CREATE UNIQUE INDEX members_household_login_name_unique
  ON members(household_id, lower(login_name))
  WHERE login_name IS NOT NULL;

CREATE TABLE member_credentials (
  member_id uuid PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE member_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX member_sessions_member_idx
  ON member_sessions(member_id, expires_at DESC);
CREATE INDEX member_sessions_active_idx
  ON member_sessions(token_hash)
  WHERE revoked_at IS NULL;

CREATE TABLE event_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  aggregate_type text,
  aggregate_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX event_outbox_pending_idx
  ON event_outbox(available_at, occurred_at)
  WHERE published_at IS NULL;
CREATE INDEX event_outbox_household_idx
  ON event_outbox(household_id, occurred_at DESC);
