BEGIN;

-- A SOL Person is canonical across plugins. One identity can belong to exactly one
-- Person, while one Person can have many identities (WhatsApp, Home Assistant,
-- Audio voiceprints, Google accounts, etc.). The original 0009 schema accidentally
-- made entity_id UNIQUE, enforcing a one-to-one relationship.
ALTER TABLE identity_entity_links
  DROP CONSTRAINT IF EXISTS identity_entity_links_entity_id_key;

CREATE INDEX IF NOT EXISTS identity_entity_links_entity_idx
  ON identity_entity_links(entity_id);

COMMIT;
