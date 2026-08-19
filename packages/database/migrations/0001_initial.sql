BEGIN;

CREATE TYPE member_role AS ENUM ('owner', 'adult', 'member', 'child', 'guest');
CREATE TYPE member_status AS ENUM ('active', 'invited', 'disabled');
CREATE TYPE visibility_scope AS ENUM ('private', 'shared', 'family', 'project', 'system');
CREATE TYPE source_status AS ENUM ('connected', 'disconnected', 'error');
CREATE TYPE entity_kind AS ENUM ('person', 'organization', 'place', 'project', 'device', 'product', 'topic', 'other');
CREATE TYPE task_status AS ENUM ('candidate', 'open', 'done', 'cancelled');

CREATE TABLE households (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  role member_role NOT NULL DEFAULT 'member',
  status member_status NOT NULL DEFAULT 'active',
  locale text,
  timezone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX members_household_idx ON members(household_id);

-- Identities let one person map to phone numbers, e-mail addresses, voice IDs, etc.
CREATE TABLE identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  kind text NOT NULL,
  provider text,
  external_value text NOT NULL,
  normalized_value text,
  label text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, kind, provider, external_value)
);
CREATE INDEX identities_member_idx ON identities(member_id);

-- A source account is separate from a member. owner_member_id NULL means household/shared.
CREATE TABLE source_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  provider text NOT NULL,
  external_account_id text,
  label text NOT NULL,
  status source_status NOT NULL DEFAULT 'disconnected',
  auth_mode text,
  secret_ref text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, provider, external_account_id)
);
CREATE INDEX source_accounts_household_idx ON source_accounts(household_id);
CREATE INDEX source_accounts_owner_idx ON source_accounts(owner_member_id);

CREATE TABLE sync_cursors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  stream text NOT NULL DEFAULT 'default',
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_account_id, stream)
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  title text,
  kind text NOT NULL DEFAULT 'direct',
  owner_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  visibility visibility_scope NOT NULL DEFAULT 'private',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_account_id, external_id)
);
CREATE INDEX conversations_household_idx ON conversations(household_id);

CREATE TABLE conversation_participants (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  display_name text,
  PRIMARY KEY(conversation_id, identity_id)
);

-- Generic immutable-ish ingestion envelope. Provider payload is retained for audit/reprocessing.
CREATE TABLE source_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  kind text NOT NULL,
  owner_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  visibility visibility_scope NOT NULL DEFAULT 'private',
  occurred_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  title text,
  body_text text,
  content_hash text,
  raw_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted_at timestamptz,
  UNIQUE(source_account_id, kind, external_id)
);
CREATE INDEX source_items_household_time_idx ON source_items(household_id, occurred_at DESC);
CREATE INDEX source_items_account_idx ON source_items(source_account_id);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_item_id uuid NOT NULL UNIQUE REFERENCES source_items(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  sender_identity_id uuid REFERENCES identities(id) ON DELETE SET NULL,
  is_from_owner boolean NOT NULL DEFAULT false,
  reply_to_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages(conversation_id);

-- Generic entities are the anchors for people/projects/devices/topics and future graph relations.
CREATE TABLE entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  kind entity_kind NOT NULL,
  canonical_name text NOT NULL,
  owner_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  visibility visibility_scope NOT NULL DEFAULT 'family',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entities_household_kind_idx ON entities(household_id, kind);

CREATE TABLE entity_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias text NOT NULL,
  normalized_alias text,
  source text,
  UNIQUE(entity_id, alias)
);

CREATE TABLE relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  subject_entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate text NOT NULL,
  object_entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  confidence real NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  visibility visibility_scope NOT NULL DEFAULT 'family',
  valid_from timestamptz,
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX relations_subject_idx ON relations(subject_entity_id, predicate);
CREATE INDEX relations_object_idx ON relations(object_entity_id, predicate);

CREATE TABLE facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  subject_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
  predicate text NOT NULL,
  object_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
  object_value jsonb,
  owner_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  visibility visibility_scope NOT NULL DEFAULT 'private',
  confidence real NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  status text NOT NULL DEFAULT 'active',
  valid_from timestamptz,
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (object_entity_id IS NOT NULL OR object_value IS NOT NULL)
);
CREATE INDEX facts_subject_idx ON facts(subject_entity_id, predicate);
CREATE INDEX facts_household_idx ON facts(household_id);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  assigned_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text,
  status task_status NOT NULL DEFAULT 'candidate',
  visibility visibility_scope NOT NULL DEFAULT 'private',
  confidence real NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_household_status_idx ON tasks(household_id, status, due_at);

CREATE TABLE life_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  title text NOT NULL,
  description text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  visibility visibility_scope NOT NULL DEFAULT 'private',
  confidence real NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX life_events_household_time_idx ON life_events(household_id, starts_at);

-- Provenance: every derived object can cite one or more original source items.
CREATE TABLE source_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_item_id uuid NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  relation text NOT NULL DEFAULT 'derived_from',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_item_id, target_type, target_id, relation)
);
CREATE INDEX source_links_target_idx ON source_links(target_type, target_id);

-- Explicit grants supplement visibility scopes for shared/project data.
CREATE TABLE visibility_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  can_read boolean NOT NULL DEFAULT true,
  can_write boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(resource_type, resource_id, member_id)
);

CREATE TABLE action_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  actor_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  action_type text NOT NULL,
  target_provider text,
  target_ref text,
  approval_state text NOT NULL DEFAULT 'not_required',
  request jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX action_log_household_time_idx ON action_log(household_id, created_at DESC);

-- Semantic embeddings are intentionally not part of the mandatory base schema.
-- When SOL starts using semantic search, a separate optional pgvector migration can
-- add the vector extension/table without making Windows-native installs depend on it.

COMMIT;
