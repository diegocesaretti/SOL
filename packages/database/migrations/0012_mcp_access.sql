CREATE TABLE mcp_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  label text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT ARRAY['read']::text[],
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcp_access_tokens_label_len CHECK (char_length(label) BETWEEN 1 AND 120)
);

CREATE INDEX mcp_access_tokens_member_idx
  ON mcp_access_tokens(household_id, member_id, created_at DESC);

CREATE INDEX mcp_access_tokens_active_idx
  ON mcp_access_tokens(token_hash)
  WHERE revoked_at IS NULL;

-- MCP tokens are member identities, not household-admin bypasses. The clear token is
-- returned once at creation time; only its SHA-256 hash is persisted in PostgreSQL.
