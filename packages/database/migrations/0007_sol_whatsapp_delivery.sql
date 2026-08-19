CREATE TABLE sol_whatsapp_deliveries (
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_account_id, member_id, event_type, aggregate_id)
);
CREATE INDEX sol_whatsapp_deliveries_retry_idx
  ON sol_whatsapp_deliveries(status, updated_at)
  WHERE status <> 'sent';
