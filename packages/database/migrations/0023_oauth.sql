BEGIN;

CREATE TABLE oauth_provider_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  plugin_id text NOT NULL,
  provider text NOT NULL,
  authorization_url text NOT NULL,
  token_url text NOT NULL,
  redirect_uri text NOT NULL,
  client_id text NOT NULL,
  client_auth text NOT NULL DEFAULT 'none',
  client_secret_credential_id uuid REFERENCES credentials(id) ON DELETE SET NULL,
  default_scopes text[] NOT NULL DEFAULT '{}',
  authorization_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  token_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  use_pkce boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (client_auth IN ('none', 'body', 'basic')),
  UNIQUE (household_id, owner_member_id, plugin_id, provider)
);

CREATE TABLE oauth_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash text NOT NULL UNIQUE,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  plugin_id text NOT NULL,
  provider text NOT NULL,
  connection_id uuid REFERENCES connections(id) ON DELETE SET NULL,
  code_verifier text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  redirect_uri text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  credential_id uuid REFERENCES credentials(id) ON DELETE SET NULL,
  last_error text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('pending', 'processing', 'completed', 'error', 'expired'))
);

CREATE INDEX oauth_flows_owner_idx
  ON oauth_flows(household_id, owner_member_id, plugin_id, created_at DESC);
CREATE INDEX oauth_flows_expiry_idx ON oauth_flows(expires_at)
  WHERE status = 'pending';

COMMIT;
