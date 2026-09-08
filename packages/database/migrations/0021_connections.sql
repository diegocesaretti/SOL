BEGIN;

CREATE TABLE connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_member_id uuid REFERENCES members(id) ON DELETE CASCADE,
  plugin_id text NOT NULL,
  provider text NOT NULL,
  external_account_id text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('connected', 'disconnected', 'needs_auth', 'syncing', 'error')),
  scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX connections_private_account_unique
  ON connections(household_id, owner_member_id, plugin_id, provider, external_account_id)
  WHERE owner_member_id IS NOT NULL;

CREATE UNIQUE INDEX connections_shared_account_unique
  ON connections(household_id, plugin_id, provider, external_account_id)
  WHERE owner_member_id IS NULL;

CREATE INDEX connections_household_idx ON connections(household_id, updated_at DESC);
CREATE INDEX connections_plugin_idx ON connections(household_id, plugin_id, updated_at DESC);
CREATE INDEX connections_owner_idx ON connections(owner_member_id, updated_at DESC)
  WHERE owner_member_id IS NOT NULL;

COMMIT;
