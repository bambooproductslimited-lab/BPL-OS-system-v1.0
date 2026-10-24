-- Customers' answers to an estimate or a quotation on its link
-- (documentAnswers.service.js): approved with their name and signature,
-- declined with a reason, or changes asked for. Every answer is kept; the
-- document carries the latest.
CREATE TABLE document_responses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type  text NOT NULL CHECK (document_type IN ('quotation', 'estimate')),
  document_id    uuid NOT NULL,
  share_id       uuid NULL REFERENCES document_shares(id) ON DELETE SET NULL,
  action         text NOT NULL CHECK (action IN ('approved', 'declined', 'changes')),
  name           text NOT NULL DEFAULT '',
  note           text NOT NULL DEFAULT '',
  signature      jsonb NULL,
  ip             text NOT NULL DEFAULT '',
  user_agent     text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_document_responses_doc ON document_responses (document_type, document_id, created_at DESC);
ALTER TABLE estimates ADD COLUMN client_answer text NULL CHECK (client_answer IN ('approved', 'declined', 'changes'));
ALTER TABLE estimates ADD COLUMN client_answered_at timestamptz NULL;
ALTER TABLE estimates ADD COLUMN viewed_at timestamptz NULL;
ALTER TABLE quotations ADD COLUMN client_answer text NULL CHECK (client_answer IN ('approved', 'declined', 'changes'));
ALTER TABLE quotations ADD COLUMN client_answered_at timestamptz NULL;
ALTER TABLE quotations ADD COLUMN viewed_at timestamptz NULL;
ALTER TABLE invoices ADD COLUMN viewed_at timestamptz NULL;

-- Invoices paid online, by card or Mobile Money through Paystack, from the
-- invoice's link (invoicePay.service.js): each payment started, and the
-- invoice payment it became once paid.
CREATE TABLE invoice_online_payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  share_id    uuid NULL REFERENCES document_shares(id) ON DELETE SET NULL,
  reference   text NOT NULL UNIQUE,
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  currency    text NOT NULL,
  url         text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'abandoned')),
  channel     text NOT NULL DEFAULT '',
  card_brand  text NULL,
  card_last4  text NULL,
  fees        numeric(14,2) NULL,
  payment_id  uuid NULL REFERENCES payments(id) ON DELETE SET NULL,
  -- Paid but not recorded (more than was owed by then): left to the rep.
  problem     text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  checked_at  timestamptz NULL,
  paid_at     timestamptz NULL
);
CREATE INDEX idx_invoice_online_payments_invoice ON invoice_online_payments (invoice_id, created_at DESC);
ALTER TABLE payments DROP CONSTRAINT payments_source_check;
ALTER TABLE payments ADD CONSTRAINT payments_source_check CHECK (source IN ('manual', 'square', 'refund', 'online'));

-- Recurring invoices (invoiceSeries.service.js): an invoice repeated every
-- week, month, quarter or year from a date, until a date or a number of
-- times. Each one is raised on its day (and emailed when asked), once.
CREATE TABLE invoice_series (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_invoice_id uuid NULL REFERENCES invoices(id) ON DELETE SET NULL,
  customer_id         uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name                text NOT NULL DEFAULT '',
  every               text NOT NULL CHECK (every IN ('week', 'month', 'quarter', 'year')),
  every_n             integer NOT NULL DEFAULT 1 CHECK (every_n BETWEEN 1 AND 12),
  next_on             date NOT NULL,
  ends_on             date NULL,
  max_count           integer NULL CHECK (max_count IS NULL OR max_count > 0),
  raised              integer NOT NULL DEFAULT 0,
  due_days            integer NOT NULL DEFAULT 14 CHECK (due_days BETWEEN 0 AND 365),
  auto_email          boolean NOT NULL DEFAULT false,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
  last_error          text NOT NULL DEFAULT '',
  created_by          uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_invoice_series_due ON invoice_series (status, next_on);
ALTER TABLE invoices ADD COLUMN series_id uuid NULL REFERENCES invoice_series(id) ON DELETE SET NULL;
ALTER TABLE invoices ADD COLUMN series_period date NULL;
CREATE UNIQUE INDEX ux_invoices_series_period ON invoices (series_id, series_period) WHERE series_id IS NOT NULL;

-- Item options (catalog.service.js options): an item's options — Size:
-- Small, Medium, Large; Finish: Natural, Dark — each variation one
-- combination of their values.
CREATE TABLE catalog_item_options (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  name        text NOT NULL,
  choices     jsonb NOT NULL DEFAULT '[]',
  sort_order  integer NOT NULL DEFAULT 0
);
CREATE INDEX idx_catalog_item_options_item ON catalog_item_options (item_id, sort_order);
ALTER TABLE catalog_item_variations ADD COLUMN option_values jsonb NOT NULL DEFAULT '{}';

-- The restaurant's rota (restaurantRota.service.js): who works when, by
-- day, planned in the till's back office and published to the staff.
CREATE TABLE restaurant_rota_shifts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  day          date NOT NULL,
  starts       time NOT NULL,
  ends         time NOT NULL,
  role         text NOT NULL DEFAULT '',
  note         text NOT NULL DEFAULT '',
  published    boolean NOT NULL DEFAULT false,
  created_by   uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_rota_week ON restaurant_rota_shifts (company_id, day);
CREATE INDEX idx_restaurant_rota_person ON restaurant_rota_shifts (employee_id, day);
