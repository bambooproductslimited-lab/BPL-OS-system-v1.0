-- The CRM's customer side (crmInbox / crmProfiles / crmHealth services):
-- every conversation with a customer from every channel, the customer
-- profiles built from them, duplicate profiles found and settled, sales reps
-- on every customer and every sales order, and follow-ups.
--
-- A customer profile IS a row of customers (the clients invoices, quotations
-- and sales orders already point at), so the CRM and Finance can never hold
-- two different people. Its sales rep is customers.account_manager_id.

-- ── profiles ─────────────────────────────────────────────────────────
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_source_check;
ALTER TABLE customers ADD CONSTRAINT customers_source_check CHECK (source IN ('manual', 'square', 'crm'));
ALTER TABLE customers ADD COLUMN origin_channel   text NOT NULL DEFAULT '';   -- where a CRM-made profile first wrote from
ALTER TABLE customers ADD COLUMN location         text NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN follow_up_on     date NULL;
ALTER TABLE customers ADD COLUMN follow_up_note   text NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN last_contact_at  timestamptz NULL;          -- last message either way
ALTER TABLE customers ADD COLUMN last_inbound_at  timestamptz NULL;
ALTER TABLE customers ADD COLUMN last_outbound_at timestamptz NULL;
ALTER TABLE customers ADD COLUMN marketing_opt_out boolean NOT NULL DEFAULT false;
ALTER TABLE customers ADD COLUMN rep_assigned_at  timestamptz NULL;
ALTER TABLE customers ADD COLUMN created_at       timestamptz NOT NULL DEFAULT now();
CREATE INDEX idx_customers_account_manager ON customers (account_manager_id);
CREATE INDEX idx_customers_follow_up ON customers (follow_up_on) WHERE follow_up_on IS NOT NULL;

-- The ways to reach a profile: a phone (also its WhatsApp), an email, an
-- Instagram or Facebook account. One way belongs to one profile, so a new
-- message from a known number lands on the right customer.
CREATE TABLE customer_identities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('phone', 'email', 'instagram', 'facebook', 'other')),
  value        text NOT NULL,          -- phone: international digits; email: lower case; social: the platform's id
  label        text NOT NULL DEFAULT '', -- how it shows: "+233 24 412 3456", "@amamensah"
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, value)
);
CREATE INDEX idx_customer_identities_customer ON customer_identities (customer_id);

-- ── conversations ────────────────────────────────────────────────────
CREATE TABLE crm_conversations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NULL REFERENCES companies(id) ON DELETE CASCADE,
  channel             text NOT NULL CHECK (channel IN ('whatsapp', 'email', 'instagram', 'facebook', 'sms', 'call', 'visit', 'other')),
  external_thread_id  text NOT NULL,     -- the channel's own thread: a WhatsApp number, an email thread, a Messenger conversation
  subject             text NOT NULL DEFAULT '',
  contact_name        text NOT NULL DEFAULT '',
  contact_label       text NOT NULL DEFAULT '',
  contact_kind        text NOT NULL DEFAULT '',  -- the sender's identity: kind and value as in customer_identities
  contact_key         text NOT NULL DEFAULT '',
  customer_id         uuid NULL REFERENCES customers(id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'spam')),
  message_count       integer NOT NULL DEFAULT 0,
  last_message_at     timestamptz NULL,
  last_direction      text NULL CHECK (last_direction IN ('in', 'out')),
  last_preview        text NOT NULL DEFAULT '',
  imported            boolean NOT NULL DEFAULT false,  -- history brought in (e.g. a WhatsApp chat export), not live
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_thread_id)
);
CREATE INDEX idx_crm_conversations_customer ON crm_conversations (customer_id);
CREATE INDEX idx_crm_conversations_last ON crm_conversations (last_message_at DESC);

CREATE TABLE crm_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
  external_id      text NULL,
  direction        text NOT NULL CHECK (direction IN ('in', 'out')),
  author_name      text NOT NULL DEFAULT '',
  body             text NOT NULL DEFAULT '',
  attachments      jsonb NOT NULL DEFAULT '[]',   -- [{ name, type }]; the files themselves stay on the channel
  sent_at          timestamptz NOT NULL,
  sent_by          uuid NULL REFERENCES employees(id) ON DELETE SET NULL,  -- a reply written in the OS
  body_tsv         tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_crm_messages_external ON crm_messages (conversation_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX idx_crm_messages_conversation ON crm_messages (conversation_id, sent_at);
CREATE INDEX idx_crm_messages_sent ON crm_messages (sent_at);
CREATE INDEX idx_crm_messages_tsv ON crm_messages USING gin (body_tsv);

-- Each channel's sync: where it got to, and what went wrong last.
CREATE TABLE crm_channel_state (
  key           text PRIMARY KEY,            -- 'email', 'facebook', 'instagram', 'coverage_alert', …
  cursor        text NULL,
  last_run_at   timestamptz NULL,
  last_ok_at    timestamptz NULL,
  last_error    text NULL,
  items         integer NOT NULL DEFAULT 0
);

-- ── data health ──────────────────────────────────────────────────────
-- Profiles that look like one customer, and what to do: merge them, delete
-- an empty one, or edit one (a near-identical name with different numbers).
CREATE TABLE crm_duplicate_suggestions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  a_id         uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  b_id         uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  score        integer NOT NULL,
  reasons      jsonb NOT NULL DEFAULT '[]',
  suggestion   text NOT NULL CHECK (suggestion IN ('merge', 'delete', 'edit')),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'merged', 'deleted', 'edited', 'dismissed')),
  decided_by   uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  decided_at   timestamptz NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (a_id < b_id),
  UNIQUE (a_id, b_id)
);
CREATE INDEX idx_crm_duplicates_status ON crm_duplicate_suggestions (status);

-- What a merge did, so it can be explained later: the profile kept, and the
-- one folded into it as it was.
CREATE TABLE customer_merges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kept_id       uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  merged_name   text NOT NULL,
  merged_snapshot jsonb NOT NULL,
  moved         jsonb NOT NULL DEFAULT '{}',   -- { invoices: 3, quotations: 1, … }
  merged_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  merged_at     timestamptz NOT NULL DEFAULT now()
);

-- ── the rep on every sales order (and so its invoice) ────────────────
ALTER TABLE sales_orders ADD COLUMN rep_id uuid NULL REFERENCES employees(id) ON DELETE SET NULL;
UPDATE sales_orders so SET rep_id = COALESCE(c.account_manager_id, so.created_by)
  FROM customers c WHERE c.id = so.customer_id;
CREATE INDEX idx_sales_orders_rep ON sales_orders (rep_id);

-- ── permission: who gives customers to reps and settles duplicates ───
INSERT INTO permissions (key, "group", label) VALUES
  ('crm.assign', 'Sales', 'Give customers to sales reps, merge and delete customer profiles')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r
JOIN (VALUES ('administrator', 'crm.assign'), ('general_manager', 'crm.assign'),
  ('marketing_manager', 'crm.assign'), ('customer_service_manager', 'crm.assign')) AS p(role_key, key) ON p.role_key = r.key
ON CONFLICT DO NOTHING;

-- Existing emails become identities now; phones are added by the CRM's
-- first run (they need the phone rules in utils/phone.js).
INSERT INTO customer_identities (customer_id, kind, value, label)
SELECT DISTINCT ON (lower(trim(email))) id, 'email', lower(trim(email)), trim(email) FROM customers
WHERE trim(email) ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' ORDER BY lower(trim(email)), status = 'active' DESC, id
ON CONFLICT (kind, value) DO NOTHING;
