-- kernel.js Phase 3 / 3.5: db.customers, db.quotations, db.salesOrders, db.invoices,
-- db.expenses, db.catalogItems, db.estimates, db.payments, db.receipts
-- Not yet wired to routes in this pass — created now for schema completeness.

CREATE TABLE customers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  contact_person       text NOT NULL DEFAULT '',
  email                text NOT NULL DEFAULT '',
  phone                text NOT NULL DEFAULT '',
  address              text NOT NULL DEFAULT '',
  category             text NOT NULL DEFAULT 'lead' CHECK (category IN ('lead', 'prospect', 'active', 'vip')),
  account_manager_id   uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  notes                text NOT NULL DEFAULT '',
  tax_id               text NOT NULL DEFAULT '',
  preferred_currency   text NOT NULL DEFAULT 'GHS',
  payment_terms        text NOT NULL DEFAULT 'Net 30',
  billing_address      text NOT NULL DEFAULT ''
);

CREATE TABLE catalog_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  code          text NOT NULL UNIQUE,
  description   text NOT NULL DEFAULT '',
  category      text NOT NULL DEFAULT '',
  unit          text NOT NULL DEFAULT 'each',
  default_qty   numeric(12,2) NOT NULL DEFAULT 1,
  unit_price    numeric(12,2) NOT NULL DEFAULT 0,
  cost_price    numeric(12,2) NOT NULL DEFAULT 0,
  tax_rate_id   text NULL, -- references settings.commercial.taxRates[].id (kept in settings jsonb, not normalized, matching the prototype)
  active        boolean NOT NULL DEFAULT true
);

CREATE TABLE quotations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_no        text NOT NULL UNIQUE,
  customer_id     uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  title           text NOT NULL DEFAULT '',
  terms           text NOT NULL DEFAULT '',
  notes           text NOT NULL DEFAULT '',
  subtotal        numeric(14,2) NOT NULL DEFAULT 0,
  discount_total  numeric(14,2) NOT NULL DEFAULT 0,
  tax_total       numeric(14,2) NOT NULL DEFAULT 0,
  grand_total     numeric(14,2) NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired')),
  created_by      uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  valid_until     date NULL
);

CREATE TABLE estimates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_no     text NOT NULL UNIQUE,
  customer_id     uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  subtotal        numeric(14,2) NOT NULL DEFAULT 0,
  discount_total  numeric(14,2) NOT NULL DEFAULT 0,
  tax_total       numeric(14,2) NOT NULL DEFAULT 0,
  grand_total     numeric(14,2) NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finalized')),
  created_by      uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  valid_until     date NULL,
  internal_notes  text NOT NULL DEFAULT '',
  client_notes    text NOT NULL DEFAULT '',
  terms           text NOT NULL DEFAULT ''
);

CREATE TABLE sales_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no       text NOT NULL UNIQUE,
  customer_id    uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  quotation_id   uuid NULL REFERENCES quotations(id) ON DELETE SET NULL,
  total          numeric(14,2) NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'fulfilled', 'cancelled')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT
);

CREATE TABLE invoices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no         text NOT NULL UNIQUE,
  sales_order_id     uuid NULL REFERENCES sales_orders(id) ON DELETE SET NULL,
  quotation_id       uuid NULL REFERENCES quotations(id) ON DELETE SET NULL,
  customer_id        uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  subtotal           numeric(14,2) NOT NULL DEFAULT 0,
  discount_total     numeric(14,2) NOT NULL DEFAULT 0,
  tax_total          numeric(14,2) NOT NULL DEFAULT 0,
  grand_total        numeric(14,2) NOT NULL DEFAULT 0,
  amount_paid        numeric(14,2) NOT NULL DEFAULT 0,
  balance_due        numeric(14,2) NOT NULL DEFAULT 0,
  po_reference       text NOT NULL DEFAULT '',
  bank_instructions  text NOT NULL DEFAULT '',
  status             text NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'partially_paid', 'paid', 'void')),
  issued_at          date NOT NULL DEFAULT CURRENT_DATE,
  due_date           date NULL,
  paid_at            date NULL
);

-- Shared multi-line-item shape used by quotations, estimates, sales orders and
-- invoices (PROJECT_NOTES.md: "snapshot pricing at document-creation time,
-- never recompute from live catalog prices later" — these rows ARE that snapshot).
CREATE TABLE document_line_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type  text NOT NULL CHECK (document_type IN ('quotation', 'estimate', 'sales_order', 'invoice')),
  document_id    uuid NOT NULL,
  sort_order     integer NOT NULL DEFAULT 0,
  description    text NOT NULL,
  qty            numeric(12,2) NOT NULL DEFAULT 1,
  unit           text NOT NULL DEFAULT 'each',
  unit_price     numeric(12,2) NOT NULL DEFAULT 0,
  discount       numeric(12,2) NOT NULL DEFAULT 0,
  discount_type  text NOT NULL DEFAULT 'fixed' CHECK (discount_type IN ('fixed', 'percent')),
  tax_rate       numeric(6,3) NOT NULL DEFAULT 0
);

CREATE INDEX idx_document_line_items_document ON document_line_items(document_type, document_id);

CREATE TABLE payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id    uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  date          date NOT NULL DEFAULT CURRENT_DATE,
  amount        numeric(14,2) NOT NULL,
  currency      text NOT NULL DEFAULT 'GHS',
  method        text NOT NULL DEFAULT 'bank_transfer' CHECK (method IN ('bank_transfer', 'cash', 'mobile_money', 'card', 'cheque')),
  reference     text NOT NULL DEFAULT '',
  received_by   uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  notes         text NOT NULL DEFAULT ''
);

-- "payment always produces a receipt" invariant (PROJECT_NOTES.md) — enforced in
-- the invoices.recordPayment handler/route, not by the schema itself.
CREATE TABLE receipts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_no     text NOT NULL UNIQUE,
  payment_id     uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  invoice_id     uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  customer_id    uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  date           date NOT NULL DEFAULT CURRENT_DATE,
  amount         numeric(14,2) NOT NULL,
  method         text NOT NULL,
  reference      text NOT NULL DEFAULT '',
  balance_after  numeric(14,2) NOT NULL,
  received_by    uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT
);

CREATE TABLE expenses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  department_id  uuid NULL REFERENCES departments(id) ON DELETE SET NULL,
  category       text NOT NULL,
  amount         numeric(14,2) NOT NULL,
  date           date NOT NULL,
  description    text NOT NULL DEFAULT '',
  project_id     uuid NULL REFERENCES projects(id) ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  decided_at     timestamptz NULL
);

CREATE INDEX idx_quotations_customer_id ON quotations(customer_id);
CREATE INDEX idx_invoices_customer_id ON invoices(customer_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_payments_invoice_id ON payments(invoice_id);
CREATE INDEX idx_expenses_status ON expenses(status);
CREATE INDEX idx_expenses_requester_id ON expenses(requester_id);
