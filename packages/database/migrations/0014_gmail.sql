CREATE TABLE gmail_oauth_credentials (
  source_account_id uuid PRIMARY KEY REFERENCES source_accounts(id) ON DELETE CASCADE,
  encrypted_payload text NOT NULL,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  last_refresh_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gmail_oauth_states (
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
CREATE INDEX gmail_oauth_states_expiry_idx ON gmail_oauth_states(expires_at);

CREATE TABLE gmail_accounts (
  source_account_id uuid PRIMARY KEY REFERENCES source_accounts(id) ON DELETE CASCADE,
  email_address text,
  history_id text,
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX gmail_accounts_sync_idx ON gmail_accounts(last_sync_at);
