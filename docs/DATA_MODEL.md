# SOL data model

## Three kinds of state

### 1. Source-backed life data

What actually arrived from a source: messages, e-mails, calendar changes, documents, sensor observations. `source_items` is the common envelope; specialized tables reference it.

### 2. Derived knowledge

What SOL inferred: entities, aliases, facts, relations, projects and eventually commitments/memories. Derived knowledge carries confidence and must be linked to source items through `source_links` whenever a source exists.

### 3. Executive state

Things SOL may act on: tasks, life events, reminders, automations and action history.

These categories must not be collapsed. Reprocessing knowledge should never destroy original source data.

## Identity model

`members` are people who use SOL inside a household. `identities` are external identifiers (phone number, e-mail, WhatsApp JID, voice identity, etc.) and can map to a member when known.

External people who are not household members can still exist as knowledge `entities`; they do not need a SOL member account.

## Source account model

`source_accounts` represents a specific connected account/session. It is intentionally separate from provider and member.

Examples:

```text
provider=whatsapp owner_member_id=A label="Personal"
provider=whatsapp owner_member_id=A label="Business"
provider=whatsapp owner_member_id=B label="Personal"
provider=google_calendar owner_member_id=NULL label="Family"
```

A connector must always identify the `source_account_id` that produced an item.

## Visibility

Initial scopes:

- `private`: owner only unless explicitly granted.
- `shared`: explicit member grants.
- `family`: readable by non-guest household members, subject to future parental/age policy.
- `project`: explicit project membership/grants.
- `system`: administrative/system state.

Visibility is **not** an AI instruction. It is enforced during retrieval before context construction.

## Provenance

`source_links` exists so SOL can answer "why do you believe this?" and show the original source. A fact without provenance is allowed only for explicit user-entered/system-created state and should record that origin in metadata in later migrations.

## Vector search

Embeddings are an index, never the canonical memory. Structured queries should answer structured questions (calendar, tasks, people, projects). Semantic search is used when wording/topic similarity is useful.
