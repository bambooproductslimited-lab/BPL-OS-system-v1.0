-- The restaurant till (restaurantPos.service.js).
--
-- cash_tendered: what the customer handed over for a cash sale, so the
-- receipt can show the change given. NULL for other payment methods, and
-- for cash sales rung up before this (or where the cashier didn't enter it).
ALTER TABLE restaurant_orders ADD COLUMN cash_tendered numeric NULL;

-- Open tables: an order kept on the till to add to and pay later (a table
-- that orders a second round, a tab at the bar). Not a sale until it is
-- paid — nothing here counts in sales or reports; paying one rings up a
-- normal order at the menu's prices of the moment and removes the tab in
-- the same transaction. items: [{ menuItemId, variationId, qty }].
CREATE TABLE restaurant_open_tabs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  label       text NOT NULL DEFAULT '',
  table_id    uuid NULL REFERENCES restaurant_tables(id) ON DELETE SET NULL,
  waiter_id   uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  guest_id    uuid NULL REFERENCES restaurant_guests(id) ON DELETE SET NULL,
  items       jsonb NOT NULL DEFAULT '[]'::jsonb,
  opened_by   uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_open_tabs_company ON restaurant_open_tabs(company_id, updated_at);
