# SOL data model

## Three kinds of state

### 1. Source-backed life data

What actually arrived from a source: messages, e-mails, calendar changes, documents, sensor observations. `source_items` is the common envelope; specialized tables reference it.

### 2. Derived knowledge

What SOL inferred: entities, aliases, facts, relations, projects and eventually commitments/memories. Derived knowledge carries confidence and must be linked to source items through `source_links` whenever a source exists.

### 3. Executive state

Things SOL may act on: tasks, life events, reminders, automations and action history.

These categories must not be collapsed. Reprocessing knowledge should never destroy original source data.

## Household + member identity

`households` is the primary tenancy/privacy boundary.

`members` are people who use SOL inside a household. A member has a role, status and optional `login_name`; credentials are deliberately stored separately in `member_credentials`.

`identities` are external identifiers (phone number, e-mail, WhatsApp JID, voice identity, etc.) and can map to a member when known.

External people who are not household members can still exist as knowledge `entities`; they do not need a SOL member account.

## Authentication state

Authentication is not mixed into life/knowledge tables:

- `member_credentials` stores the password hash for a member;
- `member_sessions` stores hashed session tokens, expiry, last-seen and revocation state;
- browser plaintext session tokens exist only in the `HttpOnly` cookie and are never persisted as plaintext.

This can later be extended with passkeys/OAuth without changing the member or life-data model.

## Source account model

`source_accounts` represents a specific connected account/session. It is intentionally separate from provider and member.

Examples:

```text
provider=whatsapp owner_member_id=A label="Personal"
provider=whatsapp owner_member_id=A label="Business"
provider=whatsapp owner_member_id=B label="Personal"
provider=google_calendar owner_member_id=NULL label="Family"
```

`owner_member_id = NULL` means a household/shared source account. A connector must always identify the `source_account_id` that produced an item.

The row contains connection metadata and `secret_ref`, not the provider credential itself.

## Visibility

Initial scopes:

- `private`: owner only unless explicitly granted.
- `shared`: explicit member grants.
- `family`: readable by non-guest household members, subject to future parental/age policy.
- `project`: explicit project membership/grants.
- `system`: administrative/system state.

Visibility is **not** an AI instruction. It is enforced during retrieval before context construction. Being the household `owner` does not override another member's `private` scope.

## Provenance

`source_links` exists so SOL can answer "why do you believe this?" and show the original source. A fact without provenance is allowed only for explicit user-entered/system-created state and should record that origin in metadata.

## Durable event outbox

`event_outbox` records domain events in the same database transaction as state changes that must emit them. Examples already produced by Phase 1:

```text
household.bootstrapped
member.created
source_account.created
```

A dispatcher will later claim unpublished rows and publish them into SOL's runtime event bus. This avoids losing an event if the process crashes immediately after a database commit.

## Vector search

Embeddings are an index, never the canonical memory. Structured queries should answer structured questions (calendar, tasks, people, projects). Semantic search is used when wording/topic similarity is useful.
