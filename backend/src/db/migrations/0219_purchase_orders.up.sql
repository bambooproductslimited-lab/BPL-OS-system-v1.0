-- Purchase orders (purchaseOrders.service.js): the document Bamboo
-- Products (or another of our companies) sends a supplier or a bamboo
-- farmer — "PURCHASE ORDER – BAMBOO POLES", PO No. BPL 004 — with what is
-- bought (description, specification, quantity, unit price), the quality
-- asked for, where and when it is to be delivered, and who prepared it.
-- Made as a draft, sent to the supplier (issued), then delivered (with what
-- actually came) or cancelled.
CREATE TABLE purchase_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  number              text NOT NULL CHECK (length(number) BETWEEN 1 AND 30),  -- BPL 004
  title               text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),   -- Bamboo poles
  po_date             date NOT NULL DEFAULT current_date,
  supplier_id         uuid NULL REFERENCES suppliers(id) ON DELETE SET NULL,
  supplier_name       text NOT NULL CHECK (length(supplier_name) BETWEEN 1 AND 160),
  supplier_location   text NOT NULL DEFAULT '',
  supplier_contact    text NOT NULL DEFAULT '',
  currency            text NOT NULL DEFAULT 'GHS' CHECK (currency ~ '^[A-Z]{3}$'),
  total               numeric(14,2) NOT NULL DEFAULT 0,
  quality             jsonb NOT NULL DEFAULT '[]'::jsonb,                     -- ["Minimum length of 14 feet.", …]
  delivery_location   text NOT NULL DEFAULT '',
  delivery_date       date NULL,
  notes               text NOT NULL DEFAULT '',
  prepared_by         uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  prepared_name       text NOT NULL DEFAULT '',
  prepared_position   text NOT NULL DEFAULT '',
  prepared_signature  text NOT NULL DEFAULT '',                               -- initials, as signed
  prepared_on         date NULL,
  request_id          uuid NULL REFERENCES procurement_requests(id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'delivered', 'cancelled')),
  issued_at           timestamptz NULL,
  delivered_on        date NULL,
  delivery_note       text NOT NULL DEFAULT '',
  cancelled_at        timestamptz NULL,
  cancel_reason       text NOT NULL DEFAULT '',
  created_by          uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, number)
);
CREATE INDEX idx_purchase_orders_date ON purchase_orders (po_date DESC, created_at DESC);
CREATE INDEX idx_purchase_orders_supplier ON purchase_orders (supplier_id);

CREATE TABLE purchase_order_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id          uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  sort_order     integer NOT NULL DEFAULT 0,
  description    text NOT NULL CHECK (length(description) BETWEEN 1 AND 160),
  specification  text NOT NULL DEFAULT '',
  quantity       numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit           text NOT NULL DEFAULT 'pcs',
  unit_price     numeric(14,4) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  total          numeric(14,2) NOT NULL DEFAULT 0,
  received_qty   numeric(14,3) NULL CHECK (received_qty IS NULL OR received_qty >= 0)
);
CREATE INDEX idx_purchase_order_lines ON purchase_order_lines (po_id, sort_order);
