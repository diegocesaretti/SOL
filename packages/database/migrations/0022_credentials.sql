BEGIN;

CREATE TABLE credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  plugin_id text NOT NULL,
  provider text NOT NULL,
  kind text NOT NULL DEFAULT 'token',
  label text NOT NULL,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(plugin_id) BETWEEN 1 AND 64),
  CHECK (char_length(provider) BETWEEN 1 AND 64),
  CHECK (char_length(kind) BETWEEN 1 AND 64),
  CHECK (char_length(label) BETWEEN 1 AND 200)
);

CREATE INDEX credentials_owner_idx
  ON credentials(household_id, owner_member_id, plugin_id, updated_at DESC);

ALTER TABLE connections
  ADD COLUMN credential_id uuid REFERENCES credentials(id) ON DELETE SET NULL;

CREATE INDEX connections_credential_idx ON connections(credential_id)
  WHERE credential_id IS NOT NULL;

COMMIT;
