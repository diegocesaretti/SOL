CREATE TABLE home_assistant_credentials (
  source_account_id uuid PRIMARY KEY REFERENCES source_accounts(id) ON DELETE CASCADE,
  base_url text NOT NULL,
  encrypted_token text NOT NULL,
  ha_version text,
  last_connected_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Discovery and current state mirror. Selection is explicit so SOL does not ingest every
-- high-frequency sensor in a Home Assistant installation by default.
CREATE TABLE home_assistant_entities (
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  entity_id text NOT NULL,
  domain text NOT NULL,
  friendly_name text,
  device_class text,
  unit_of_measurement text,
  selected_for_sync boolean NOT NULL DEFAULT false,
  selected_for_control boolean NOT NULL DEFAULT false,
  record_mode text NOT NULL DEFAULT 'changes'
    CHECK (record_mode IN ('snapshot', 'changes')),
  current_state text,
  current_attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_changed timestamptz,
  last_updated timestamptz,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_account_id, entity_id)
);
CREATE INDEX home_assistant_entities_selected_idx
  ON home_assistant_entities(source_account_id, selected_for_sync, entity_id);
CREATE INDEX home_assistant_entities_domain_idx
  ON home_assistant_entities(source_account_id, domain, friendly_name);

-- Future control permissions are intentionally separate from source visibility. No Phase 6
-- route executes services; this table lets a later action policy grant entity capabilities
-- without retrofitting read permissions into the connector.
CREATE TABLE home_assistant_control_grants (
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  entity_id text NOT NULL,
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  service_domain text NOT NULL,
  service_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_account_id, entity_id, member_id, service_domain, service_name),
  FOREIGN KEY(source_account_id, entity_id)
    REFERENCES home_assistant_entities(source_account_id, entity_id) ON DELETE CASCADE
);
