# Panorama 0.15.26 – Codex and incremental daily scanning

- Codex App Server now uses the current read-only turn sandbox policy. The thread remains in read-only mode with approvals disabled; the assistant receives instructions to treat source text as untrusted.
- Panorama scans Life in 500-item keyset pages (timestamp, type, ID), up to a safety ceiling of 50,000 records per edition. Equal-timestamp events are retained across page boundaries.
- Only event keys and source totals are persisted to compare subsequent editions; later editions reread the recent 8-hour overlap to recognize delayed messages without recounting observations already in the prior edition.
- Older 0.15.25 structured editions at the 500-event cap can be expanded when the user creates a retrospective edition for the same date. Codex rewrites the previous structured text as prose and considers newly discovered evidence.
- The language model is passed a balanced, 85-event sample plus complete source counts rather than raw content from all 50,000 possible events. The UI must not claim full semantic comprehension when records exceed this sample.
- Scheduled editions wait 30 seconds after server startup before their first attempt, reducing false fallback caused by Codex/Postgres startup races.
- If Codex is disconnected, the existing verifiable structured-fallback path remains available and accurately labeled.

Manual edition date range, privacy checks, and user-scoped database storage remain unchanged.
