CREATE TABLE mercadolibre_oauth_states (
  state_hash text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  code_verifier text NOT NULL,
  redirect_after text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mercadolibre_oauth_states_expiry_idx
  ON mercadolibre_oauth_states(expires_at);

CREATE TABLE mercadolibre_oauth_credentials (
  source_account_id uuid PRIMARY KEY REFERENCES source_accounts(id) ON DELETE CASCADE,
  encrypted_payload text NOT NULL,
  user_id text,
  nickname text,
  site_id text,
  country_id text,
  granted_scope text,
  expires_at timestamptz,
  last_refresh_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mercadolibre_credentials_user_idx
  ON mercadolibre_oauth_credentials(user_id);

CREATE TABLE mercadolibre_items (
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  item_id text NOT NULL,
  title text NOT NULL,
  status text NOT NULL,
  price numeric,
  currency_id text,
  available_quantity integer,
  sold_quantity integer,
  listing_type_id text,
  condition text,
  permalink text,
  catalog_product_id text,
  seller_custom_field text,
  date_created timestamptz,
  last_updated timestamptz,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_account_id, item_id)
);
CREATE INDEX mercadolibre_items_status_idx
  ON mercadolibre_items(source_account_id, status, updated_at DESC);

CREATE TABLE mercadolibre_orders (
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  order_id text NOT NULL,
  status text NOT NULL,
  status_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_amount numeric,
  currency_id text,
  buyer_id text,
  buyer_nickname text,
  pack_id text,
  shipping_id text,
  order_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  payments jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags text[] NOT NULL DEFAULT '{}'::text[],
  date_created timestamptz,
  date_closed timestamptz,
  date_last_updated timestamptz,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_account_id, order_id)
);
CREATE INDEX mercadolibre_orders_time_idx
  ON mercadolibre_orders(source_account_id, COALESCE(date_closed, date_created) DESC);
CREATE INDEX mercadolibre_orders_status_idx
  ON mercadolibre_orders(source_account_id, status);

CREATE TABLE mercadolibre_questions (
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  question_id text NOT NULL,
  item_id text,
  status text NOT NULL,
  question_text text NOT NULL,
  from_user_id text,
  answer jsonb,
  date_created timestamptz,
  date_answered timestamptz,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_account_id, question_id)
);
CREATE INDEX mercadolibre_questions_status_idx
  ON mercadolibre_questions(source_account_id, status, date_created DESC);

-- The first connector is reconciliation/polling based. Public webhook notifications are
-- intentionally deferred until SOL has an HTTPS deployment endpoint that can validate
-- Mercado Libre callbacks safely.
