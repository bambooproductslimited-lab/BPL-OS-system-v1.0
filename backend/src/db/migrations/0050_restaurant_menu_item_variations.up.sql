-- Restaurant module: named price variations per menu item, matching the
-- real Square POS's own "Variations" picker (one dish, several named
-- options each with its own price — e.g. Cucumber with Garlic: "M" ₵98 vs
-- "Jellyfish" ₵238) rather than the current one-flat-price-per-row model.
-- Purely additive: an item with no rows here still sells at its own
-- restaurant_menu_items.price exactly as before; the POS till only shows a
-- variation picker for items that have rows.
CREATE TABLE restaurant_menu_item_variations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id uuid NOT NULL REFERENCES restaurant_menu_items(id) ON DELETE CASCADE,
  name         text NOT NULL,
  price        numeric NOT NULL DEFAULT 0,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_menu_item_variations_item ON restaurant_menu_item_variations(menu_item_id);

-- Line items already store their own denormalized name/unit_price (see
-- migration 0041), so the variation actually sold is captured there without
-- a schema change — this column just lets an order line point back at
-- which variation row it was, for future reporting.
ALTER TABLE restaurant_order_items ADD COLUMN variation_id uuid NULL REFERENCES restaurant_menu_item_variations(id) ON DELETE SET NULL;
