-- The till's bill, closer to what a full restaurant till does
-- (restaurantPos.service.js, restaurantTillCheck.service.js):
--
-- Add-ons: groups of choices a dish can take ("Pick a side: rice or
-- banku", "Extras: egg +5"), each choice with its price; a group says how
-- many to pick (at least min_pick, at most max_pick, none = any). A group
-- belongs to the restaurant and is put on the dishes that take it. A line
-- of a sale keeps what was picked, as it was (modifiers); the kitchen sees
-- it with the dish (restaurant_kitchen_items.mods).
CREATE TABLE restaurant_modifier_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  min_pick    integer NOT NULL DEFAULT 0 CHECK (min_pick >= 0),
  max_pick    integer NULL CHECK (max_pick IS NULL OR max_pick >= 1),
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_modifier_groups_company ON restaurant_modifier_groups (company_id);
CREATE TABLE restaurant_modifiers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    uuid NOT NULL REFERENCES restaurant_modifier_groups(id) ON DELETE CASCADE,
  name        text NOT NULL,
  price       numeric(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_modifiers_group ON restaurant_modifiers (group_id);
CREATE TABLE restaurant_menu_item_modifier_groups (
  menu_item_id  uuid NOT NULL REFERENCES restaurant_menu_items(id) ON DELETE CASCADE,
  group_id      uuid NOT NULL REFERENCES restaurant_modifier_groups(id) ON DELETE CASCADE,
  sort_order    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (menu_item_id, group_id)
);
CREATE INDEX idx_restaurant_item_modifier_groups_group ON restaurant_menu_item_modifier_groups (group_id);
ALTER TABLE restaurant_kitchen_items ADD COLUMN mods text NOT NULL DEFAULT '';

-- A line's add-ons, its discount (or "on the house", with why) and who
-- allowed it. gross (migration 0098) is what the line sold for before
-- discounts; line_total what was paid for it.
ALTER TABLE restaurant_order_items
  ADD COLUMN modifiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN discount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN discount_name text NULL,
  ADD COLUMN comp_reason text NULL;

-- The sale's discounts, service charge and taxes: subtotal is the dishes
-- after their discounts; total is what was paid (subtotal, the service
-- charge and any tax added on top). taxes lists each tax with its amount
-- (included in the prices, or added); adjustments the bill-wide discount,
-- a service charge taken off, and who allowed each.
-- receipt_token: the link to the sale's receipt on the restaurant's
-- website, to send the customer by WhatsApp or SMS (receipt_sends).
ALTER TABLE restaurant_orders
  ADD COLUMN discount_total numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN service_charge numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN tax_total numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN taxes jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN adjustments jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN receipt_token text NULL,
  ADD COLUMN receipt_sends jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE UNIQUE INDEX ux_restaurant_orders_receipt_token ON restaurant_orders (receipt_token) WHERE receipt_token IS NOT NULL;

-- An open order's bill-wide discount and service charge taken off, kept
-- with it until it is paid.
ALTER TABLE restaurant_open_tabs ADD COLUMN adjust jsonb NOT NULL DEFAULT '{}'::jsonb;

-- A website order's service charge and taxes, when the restaurant charges
-- them on deliveries or pickups (total includes them).
ALTER TABLE restaurant_online_orders ADD COLUMN charges jsonb NOT NULL DEFAULT '{}'::jsonb;
