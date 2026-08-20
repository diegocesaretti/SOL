CREATE TABLE knowledge_consolidation_items (
  source_item_id uuid PRIMARY KEY REFERENCES source_items(id) ON DELETE CASCADE,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'analyzed'
    CHECK (status IN ('analyzed', 'failed')),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  provider text,
  model_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  analyzed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX knowledge_consolidation_household_status_idx
  ON knowledge_consolidation_items(household_id, status, updated_at);

-- This table records that a source item has already participated in a consolidation
-- pass. Durable Knowledge itself stays in entities/facts/source_links. Failed items
-- can be retried a bounded number of times without repeatedly reprocessing the full
-- Life history.
