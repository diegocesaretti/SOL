ALTER TABLE knowledge_consolidation_items
  DROP CONSTRAINT IF EXISTS knowledge_consolidation_items_status_check;

ALTER TABLE knowledge_consolidation_items
  ADD CONSTRAINT knowledge_consolidation_items_status_check
  CHECK (status IN ('analyzed', 'failed', 'ignored'));

-- `ignored` means the deterministic Intelligence Gate examined the Life item and
-- decided it should remain available in Life but should not consume LLM quota for
-- durable Knowledge consolidation.
