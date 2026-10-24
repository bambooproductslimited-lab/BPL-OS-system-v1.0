-- Combos (restaurantTillCheck groupsFor, restaurantTillMenu saveCombo): a
-- dish sold at a set price for one of each slot's choices — a main, a
-- side, a drink — each choice another dish on the menu (or one size of
-- it), with what it adds to the price. A dish with slots is a combo.
CREATE TABLE restaurant_combo_slots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id  uuid NOT NULL REFERENCES restaurant_menu_items(id) ON DELETE CASCADE,
  name          text NOT NULL,
  min_pick      integer NOT NULL DEFAULT 1 CHECK (min_pick >= 0 AND min_pick <= 10),
  max_pick      integer NOT NULL DEFAULT 1 CHECK (max_pick >= 1 AND max_pick <= 10),
  sort_order    integer NOT NULL DEFAULT 0
);
CREATE INDEX idx_restaurant_combo_slots_item ON restaurant_combo_slots (menu_item_id, sort_order);
CREATE TABLE restaurant_combo_options (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id       uuid NOT NULL REFERENCES restaurant_combo_slots(id) ON DELETE CASCADE,
  menu_item_id  uuid NOT NULL REFERENCES restaurant_menu_items(id) ON DELETE CASCADE,
  variation_id  uuid NULL REFERENCES restaurant_menu_item_variations(id) ON DELETE CASCADE,
  extra         numeric(12,2) NOT NULL DEFAULT 0 CHECK (extra >= 0),
  sort_order    integer NOT NULL DEFAULT 0
);
CREATE INDEX idx_restaurant_combo_options_slot ON restaurant_combo_options (slot_id, sort_order);

-- Deals (restaurantPromos.service.js) given on the website or the kiosk:
-- the deal and its code, carried to the open order on the till.
ALTER TABLE restaurant_online_orders ADD COLUMN adjust jsonb NOT NULL DEFAULT '{}';
ALTER TABLE restaurant_table_orders ADD COLUMN adjust jsonb NOT NULL DEFAULT '{}';

-- Suppliers and purchase orders (restaurantPurchasing.service.js): who a
-- counted dish, an ingredient or a supply is bought from; an order to a
-- supplier, sent on WhatsApp or by email, and received into the stock.
CREATE TABLE restaurant_suppliers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  phone       text NOT NULL DEFAULT '',
  email       text NOT NULL DEFAULT '',
  note        text NOT NULL DEFAULT '',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_suppliers_company ON restaurant_suppliers (company_id, name);
ALTER TABLE restaurant_menu_items ADD COLUMN supplier_id uuid NULL REFERENCES restaurant_suppliers(id) ON DELETE SET NULL;
ALTER TABLE restaurant_ingredients ADD COLUMN supplier_id uuid NULL REFERENCES restaurant_suppliers(id) ON DELETE SET NULL;
ALTER TABLE restaurant_supplies ADD COLUMN supplier_id uuid NULL REFERENCES restaurant_suppliers(id) ON DELETE SET NULL;
CREATE TABLE restaurant_purchase_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number          integer NOT NULL,
  supplier_id     uuid NULL REFERENCES restaurant_suppliers(id) ON DELETE SET NULL,
  supplier_name   text NOT NULL DEFAULT '',
  supplier_phone  text NOT NULL DEFAULT '',
  supplier_email  text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'received', 'cancelled')),
  note            text NOT NULL DEFAULT '',
  expected_on     date NULL,
  total           numeric(14,2) NOT NULL DEFAULT 0,
  created_by      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz NULL,
  received_at     timestamptz NULL,
  received_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  UNIQUE (company_id, number)
);
CREATE INDEX idx_restaurant_pos_company ON restaurant_purchase_orders (company_id, created_at DESC);
CREATE TABLE restaurant_purchase_order_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id         uuid NOT NULL REFERENCES restaurant_purchase_orders(id) ON DELETE CASCADE,
  item_type     text NOT NULL CHECK (item_type IN ('menu', 'ingredient', 'supply')),
  item_id       uuid NOT NULL,
  name          text NOT NULL,
  unit          text NOT NULL DEFAULT '',
  qty           numeric(12,3) NOT NULL CHECK (qty > 0),
  unit_cost     numeric(12,4) NOT NULL DEFAULT 0,
  received_qty  numeric(12,3) NULL,
  sort_order    integer NOT NULL DEFAULT 0
);
CREATE INDEX idx_restaurant_po_lines_po ON restaurant_purchase_order_lines (po_id, sort_order);

-- The day closed (restaurantCloseDay.service.js): its summary as it was
-- when closed — by a manager on the till, or on its own at the set time —
-- and who was sent it.
CREATE TABLE restaurant_day_closes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  day         date NOT NULL,
  closed_at   timestamptz NOT NULL DEFAULT now(),
  closed_by   uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  auto        boolean NOT NULL DEFAULT false,
  note        text NOT NULL DEFAULT '',
  summary     jsonb NOT NULL,
  sent        jsonb NOT NULL DEFAULT '{}',
  UNIQUE (company_id, day)
);
