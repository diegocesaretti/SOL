CREATE TYPE extraction_candidate_status AS ENUM ('pending', 'analyzed', 'ignored', 'failed');
CREATE TYPE extraction_candidate_kind AS ENUM ('unknown', 'task', 'event', 'commitment', 'deadline', 'information', 'none');

CREATE TABLE whatsapp_sessions (
  source_account_id uuid PRIMARY KEY REFERENCES source_accounts(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  linked_at timestamptz,
  phone_jid text,
  display_name text,
  history_sync_complete boolean NOT NULL DEFAULT false,
  last_connection_at timestamptz,
  last_disconnect_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- WhatsApp linked-device credentials are equivalent to a long-lived credential.
-- Payloads are encrypted by SOL before they reach PostgreSQL; the encryption key
-- lives outside the database and Git under .sol/secrets by default.
CREATE TABLE whatsapp_auth_creds (
  source_account_id uuid PRIMARY KEY REFERENCES source_accounts(id) ON DELETE CASCADE,
  encrypted_payload text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE whatsapp_auth_keys (
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  category text NOT NULL,
  key_id text NOT NULL,
  encrypted_payload text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_account_id, category, key_id)
);
CREATE INDEX whatsapp_auth_keys_account_idx
  ON whatsapp_auth_keys(source_account_id, category);

-- Provider message IDs are kept with the source account so message retries/history
-- can be correlated without exposing WhatsApp protocol state to the rest of SOL.
CREATE TABLE whatsapp_message_index (
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  remote_jid text NOT NULL,
  message_id text NOT NULL,
  source_item_id uuid NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  message_type text,
  PRIMARY KEY(source_account_id, remote_jid, message_id)
);
CREATE INDEX whatsapp_message_index_source_item_idx
  ON whatsapp_message_index(source_item_id);

-- Lightweight prefilter output. Only these candidates are eligible for semantic
-- extraction; ordinary chat traffic remains stored but never consumes AI quota.
CREATE TABLE extraction_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  source_item_id uuid NOT NULL UNIQUE REFERENCES source_items(id) ON DELETE CASCADE,
  owner_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  source_provider text NOT NULL DEFAULT 'whatsapp',
  score real NOT NULL CHECK (score >= 0 AND score <= 1),
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  status extraction_candidate_status NOT NULL DEFAULT 'pending',
  kind extraction_candidate_kind NOT NULL DEFAULT 'unknown',
  confidence real CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  extracted jsonb,
  error text,
  analyzed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX extraction_candidates_pending_idx
  ON extraction_candidates(status, created_at)
  WHERE status = 'pending';
CREATE INDEX extraction_candidates_household_idx
  ON extraction_candidates(household_id, created_at DESC);
