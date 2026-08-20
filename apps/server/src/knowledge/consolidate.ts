import { closeDatabase } from "../database/client.js";
import { consolidateNextKnowledgeBatch } from "../modules/knowledge/consolidator.js";

const requestedBatches = Number(process.argv[2] ?? 1);
const batches = Number.isInteger(requestedBatches)
  ? Math.max(1, Math.min(10, requestedBatches))
  : 1;

try {
  let totalItems = 0;
  let totalEntities = 0;
  let totalFacts = 0;
  for (let index = 0; index < batches; index += 1) {
    const result = await consolidateNextKnowledgeBatch();
    if (!result) break;
    totalItems += result.processed;
    totalEntities += result.entities;
    totalFacts += result.facts;
    console.log(
      `Batch ${index + 1}: ${result.processed} source items → ${result.entities} entities / ${result.facts} new facts`,
    );
  }
  if (!totalItems) {
    console.log(
      "No Knowledge batch was processed. There may be no eligible source items, or optional Codex enrichment may be unavailable.",
    );
  } else {
    console.log(
      `Knowledge consolidation complete: ${totalItems} items → ${totalEntities} entities / ${totalFacts} new facts`,
    );
  }
} finally {
  await closeDatabase();
}
