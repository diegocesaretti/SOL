CREATE OR REPLACE FUNCTION sol_guard_whatsapp_member_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.verified_at IS NULL OR NEW.disabled_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM sol_whatsapp_member_bindings other
    WHERE other.source_account_id = NEW.source_account_id
      AND other.member_id <> NEW.member_id
      AND other.verified_at IS NOT NULL
      AND other.disabled_at IS NULL
      AND (
        (NEW.primary_jid IS NOT NULL AND
          (other.primary_jid = NEW.primary_jid OR other.alternate_jid = NEW.primary_jid))
        OR
        (NEW.alternate_jid IS NOT NULL AND
          (other.primary_jid = NEW.alternate_jid OR other.alternate_jid = NEW.alternate_jid))
      )
  ) THEN
    RAISE EXCEPTION 'WhatsApp identity is already bound to another SOL member'
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sol_whatsapp_member_binding_guard
  ON sol_whatsapp_member_bindings;
CREATE TRIGGER sol_whatsapp_member_binding_guard
BEFORE INSERT OR UPDATE OF primary_jid, alternate_jid, verified_at, disabled_at
ON sol_whatsapp_member_bindings
FOR EACH ROW
EXECUTE FUNCTION sol_guard_whatsapp_member_binding();
