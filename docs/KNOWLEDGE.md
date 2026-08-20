# SOL Knowledge consolidation

SOL separates **what happened** from **what is durably useful**.

```text
Sources
   ↓
Life (source-backed observations)
   ↓
automatic consolidation
   ↓
Knowledge (entities + facts + routines)
   ↓
MCP
```

## Core rule

Source data is never rewritten into "truth" without provenance. Every automatically created entity/fact can be linked back to one or more original `source_items` through `source_links`.

The first consolidator is intentionally conservative and incremental.

## What happens automatically

After SOL starts, a sparse scheduler periodically looks for source items that have not been consolidated yet. It currently considers text-bearing items with `private` or `family` visibility.

Items are grouped by:

- household;
- source account;
- privacy scope;
- owning member for private data.

This prevents a consolidation prompt from mixing another member's private data into the same reasoning batch.

By default SOL runs at most:

```text
2 batches × 12 source items
every 6 hours
```

Configure with:

```dotenv
SOL_KNOWLEDGE_CONSOLIDATION_MS=21600000
SOL_KNOWLEDGE_BATCHES_PER_RUN=2
SOL_KNOWLEDGE_BATCH_ITEMS=12
```

The first pass is delayed after startup so normal source connectors and the web UI are not blocked by AI availability.

## AI is optional

The current unstructured-text consolidator can use the configured `AiProvider` (Codex is the first adapter) to extract durable knowledge. Before doing work it checks whether Codex is available.

If Codex is not installed or not authenticated:

- WhatsApp/Calendar/Home Assistant/Mercado Libre ingestion continues;
- Life continues to grow;
- MCP continues to expose normalized data;
- no source item is marked analyzed merely because AI is unavailable;
- a later consolidation pass can process it when enrichment becomes available.

This keeps AI as an enrichment dependency, not SOL's storage or runtime authority.

## Extraction policy

The consolidator asks only for reusable information such as:

- people and aliases;
- organizations;
- projects;
- places;
- products/topics;
- durable preferences/facts;
- recurring routines and schedules.

It explicitly asks the model to ignore:

- greetings;
- one-off logistics;
- transient sensor values;
- individual marketplace transactions;
- unsupported guesses;
- tasks/events that belong in Life/Executive rather than durable Knowledge.

## Example: school schedule

A WhatsApp source item might contain:

```text
Horarios Luca
Lunes: Matemática 7:30, Lengua 9:00
Martes: Inglés 7:30
```

A conservative extraction can become:

```text
entity
  person: Luca

facts
  routine.schedule:
    { day: "monday", start: "07:30", subject: "Matemática" }
  routine.schedule:
    { day: "monday", start: "09:00", subject: "Lengua" }
  routine.schedule:
    { day: "tuesday", start: "07:30", subject: "Inglés" }
```

Each fact records evidence item IDs and `source_links` point back to the original source item. This lets an MCP client answer "¿qué materias tiene Luca mañana?" without SOL needing to create a Calendar event for every class.

## Hallucination/provenance gates

An extraction is persisted only when:

- its entity kind is from SOL's allowed entity kinds;
- an entity has confidence >= 0.65;
- a fact has confidence >= 0.72;
- every entity/fact cites at least one exact source-item ID from the supplied batch;
- facts refer only to entity refs created/resolved in that extraction;
- fact JSON is bounded in size;
- predicates are normalized to a restricted machine-safe form.

Evidence IDs invented by the model are discarded.

## Privacy propagation

Derived Knowledge inherits the batch's scope:

```text
private source item → private entity/fact owned by that member
family source item  → family entity/fact
```

The current automatic consolidator deliberately skips `shared`, `project` and `system` source scopes until grant propagation is implemented explicitly. It is safer to under-consolidate than accidentally broaden visibility.

## Entity reuse

SOL conservatively reuses an existing entity only on an exact case-insensitive canonical-name/alias match within the same household/kind/privacy boundary. More aggressive alias/entity merging remains a later reconciliation stage.

## Idempotency / retries

`knowledge_consolidation_items` records which source items have participated in a pass.

- successful items are not repeatedly sent for extraction;
- failures are retained with an error;
- failed items can retry up to three times with a cooldown;
- fact equality plus `source_links` prevents duplicate derived facts/links from normal retries.

## What still needs work

The current consolidator is the first core, not the final Knowledge engine. Next layers include:

- deterministic provider-specific structured consolidation that needs no AI;
- better entity/alias merge and conflict resolution;
- fact supersession/validity rules (e.g. a school timetable changed);
- explicit `shared/project` visibility-grant propagation;
- first-class routine/schedule query tools in MCP;
- provenance drill-down from MCP/UI;
- manual review/correction tools for derived Knowledge.
