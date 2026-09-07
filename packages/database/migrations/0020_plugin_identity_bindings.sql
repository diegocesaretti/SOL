BEGIN;

-- Provider-neutral identities created by SOL plugins. The existing identities/entity graph
-- remains the source of truth; this table records plugin ownership/provenance so runtimes
-- can upsert safely without arbitrary identity access.
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

COMMIT;
