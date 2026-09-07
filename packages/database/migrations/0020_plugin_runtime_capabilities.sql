BEGIN;

-- Provider-neutral identities created by SOL plugins. The existing identities/entity graph
-- remains the source of truth; this table only records plugin ownership/provenance so a
-- runtime can upsert safely without gaining arbitrary identity write access.
CREATE TABLE plugin_identity_bindings (
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  plugin_id text NOT NULL,
  external_id text NOT NULL,
  identity_id uuid NOT NULL UNIQUE REFERENCES identities(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(household_id, plugin_id, external_id)
);
CREATE INDEX plugin_identity_bindings_plugin_idx
  ON plugin_identity_bindings(household_id, plugin_id);

-- Dynamic MCP tools are registered by a running plugin but consumed by the separate
-- Nexo/SOL MCP stdio process. Callback URLs are restricted in application code to loopback.
CREATE TABLE plugin_mcp_tools (
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  plugin_id text NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  input_schema jsonb NOT NULL DEFAULT '{"type":"object","properties":{}}'::jsonb,
  callback_url text NOT NULL,
  requires_submit boolean NOT NULL DEFAULT false,
  owner_member_id uuid REFERENCES members(id) ON DELETE CASCADE,
  visibility visibility_scope NOT NULL DEFAULT 'family',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(household_id, plugin_id, name)
);
CREATE INDEX plugin_mcp_tools_household_idx
  ON plugin_mcp_tools(household_id, name);

COMMIT;
