-- Restaurant module: table + waiter assignment and a lightweight guest
-- directory, matching what the business already uses on Square (assign a
-- table/customer to a waiter). Tables are a fixed, per-restaurant list set
-- up by management (not free text) so names stay consistent for reporting
-- — same "company_id-scoped catalogue" shape as restaurant_menu_items.
CREATE TABLE restaurant_tables (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);
CREATE INDEX idx_restaurant_tables_company ON restaurant_tables(company_id);

-- A separate, restaurant-scoped guest list — deliberately not the existing
-- `customers` table (migration 0008), which is built for Bamboo Products
-- Limited's B2B wholesale accounts (tax id, payment terms, an account
-- manager) and would carry a lot of dead weight for a walk-in diner's
-- name and phone number.
CREATE TABLE restaurant_guests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  phone       text NOT NULL DEFAULT '',
  notes       text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_guests_company_name ON restaurant_guests(company_id, name);

-- All three nullable — a quick counter sale still needs none of this;
-- they're an optional record of who served the table and who was sitting
-- at it, filled in only when the till bothers to set them.
ALTER TABLE restaurant_orders ADD COLUMN table_id uuid NULL REFERENCES restaurant_tables(id) ON DELETE SET NULL;
ALTER TABLE restaurant_orders ADD COLUMN waiter_id uuid NULL REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE restaurant_orders ADD COLUMN guest_id uuid NULL REFERENCES restaurant_guests(id) ON DELETE SET NULL;
CREATE INDEX idx_restaurant_orders_table ON restaurant_orders(table_id);
CREATE INDEX idx_restaurant_orders_waiter ON restaurant_orders(waiter_id);
CREATE INDEX idx_restaurant_orders_guest ON restaurant_orders(guest_id);
