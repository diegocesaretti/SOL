CREATE TABLE identity_entity_links (
  identity_id uuid PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL UNIQUE REFERENCES entities(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION sol_ensure_identity_person_entity(p_identity_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  identity_row identities%ROWTYPE;
  account_owner uuid;
  entity_visibility visibility_scope;
  v_entity_id uuid;
  source_account_id uuid;
BEGIN
  SELECT * INTO identity_row FROM identities WHERE id = p_identity_id;
  IF NOT FOUND OR identity_row.provider <> 'whatsapp' OR identity_row.kind <> 'whatsapp_jid' THEN
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM identity_entity_links l WHERE l.identity_id = p_identity_id) THEN
    RETURN;
  END IF;

  BEGIN
    source_account_id := NULLIF(identity_row.metadata->>'sourceAccountId', '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    source_account_id := NULL;
  END;

  IF source_account_id IS NOT NULL THEN
    SELECT sa.owner_member_id INTO account_owner
    FROM source_accounts AS sa
    WHERE sa.id = source_account_id AND sa.household_id = identity_row.household_id;
  END IF;

  -- An identity explicitly mapped to a SOL member is owned by that member. Otherwise
  -- inherit the source account owner. Shared household WhatsApp identities are family-visible.
  account_owner := COALESCE(identity_row.member_id, account_owner);
  entity_visibility := CASE WHEN account_owner IS NULL THEN 'family'::visibility_scope
                            ELSE 'private'::visibility_scope END;

  INSERT INTO entities(
    household_id, kind, canonical_name, owner_member_id, visibility, metadata
  ) VALUES (
    identity_row.household_id,
    'person',
    COALESCE(NULLIF(identity_row.label, ''), identity_row.external_value),
    account_owner,
    entity_visibility,
    jsonb_build_object(
      'origin', 'identity',
      'identityId', identity_row.id,
      'provider', identity_row.provider,
      'externalValue', identity_row.external_value
    )
  ) RETURNING id INTO v_entity_id;

  INSERT INTO identity_entity_links(identity_id, entity_id)
  VALUES (identity_row.id, v_entity_id)
  ON CONFLICT(identity_id) DO NOTHING;

  INSERT INTO entity_aliases(entity_id, alias, normalized_alias, source)
  VALUES (
    v_entity_id,
    identity_row.external_value,
    lower(identity_row.external_value),
    'whatsapp_identity'
  ) ON CONFLICT(entity_id, alias) DO NOTHING;

  IF identity_row.label IS NOT NULL AND btrim(identity_row.label) <> '' THEN
    INSERT INTO entity_aliases(entity_id, alias, normalized_alias, source)
    VALUES (
      v_entity_id,
      btrim(identity_row.label),
      lower(btrim(identity_row.label)),
      'whatsapp_push_name'
    ) ON CONFLICT(entity_id, alias) DO NOTHING;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION sol_identity_person_entity_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM sol_ensure_identity_person_entity(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS identity_person_entity_trigger ON identities;
CREATE TRIGGER identity_person_entity_trigger
AFTER INSERT OR UPDATE OF label, member_id, metadata
ON identities
FOR EACH ROW
EXECUTE FUNCTION sol_identity_person_entity_trigger();

-- Backfill identities already observed before this migration. Each call is idempotent.
DO $$
DECLARE
  v_identity_id uuid;
BEGIN
  FOR v_identity_id IN
    SELECT i.id FROM identities AS i
    WHERE i.provider = 'whatsapp' AND i.kind = 'whatsapp_jid'
  LOOP
    PERFORM sol_ensure_identity_person_entity(v_identity_id);
  END LOOP;
END;
$$;
