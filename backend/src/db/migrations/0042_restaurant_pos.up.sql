-- Restaurant module, Phase 2 (POS): a completed sale, rung up against a
-- company's own menu (migration 0041). order_no comes from a single
-- global sequence rather than the shared settings.commercial.numbering
-- config every other document type uses (documents.js's nextDocNumber) —
-- that helper locks the one settings row per call, which is fine for
-- comparatively rare quotations/invoices but would make it a contention
-- point for a POS ringing up many small sales per minute across two
-- restaurants. A sequence is race-safe under Postgres by construction and
-- needs no locking at all.
CREATE SEQUENCE restaurant_order_seq START 1;

CREATE TABLE restaurant_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_no       text NOT NULL UNIQUE,
  cashier_id     uuid NOT NULL REFERENCES employees(id),
  subtotal       numeric NOT NULL DEFAULT 0,
  total          numeric NOT NULL DEFAULT 0,
  payment_method text NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'bank_transfer', 'mobile_money', 'card', 'cheque', 'other')),
  status         text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'voided')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_orders_company ON restaurant_orders(company_id, created_at);

-- name/unit_price/line_total are a snapshot at sale time — same
-- "never recomputed from live prices later" rule documents.js's
-- buildLineItems already applies to quotations/invoices, so a later menu
-- price change or deletion can't retroactively change a past sale's total.
CREATE TABLE restaurant_order_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES restaurant_orders(id) ON DELETE CASCADE,
  menu_item_id uuid REFERENCES restaurant_menu_items(id) ON DELETE SET NULL,
  name         text NOT NULL,
  qty          numeric NOT NULL,
  unit_price   numeric NOT NULL,
  line_total   numeric NOT NULL
);
CREATE INDEX idx_restaurant_order_items_order ON restaurant_order_items(order_id);
