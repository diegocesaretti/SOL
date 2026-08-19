CREATE OR REPLACE FUNCTION sol_notify_event_outbox()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('sol_outbox', NEW.id::text);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS event_outbox_notify_trigger ON event_outbox;
CREATE TRIGGER event_outbox_notify_trigger
AFTER INSERT ON event_outbox
FOR EACH ROW
EXECUTE FUNCTION sol_notify_event_outbox();
