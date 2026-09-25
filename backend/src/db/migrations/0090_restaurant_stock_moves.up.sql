-- Restaurants (restaurant.service.js, restaurantOverview.service.js): every
-- change to a supply's or an ingredient's stock — a delivery received,
-- stock used in the kitchen, stock thrown away, a count — with the unit cost
-- at the time, so the page can show each item's history, what was wasted
-- and what was bought. item_id points at restaurant_supplies or
-- restaurant_ingredients depending on item_type (the rows are removed with
-- the item).
CREATE TABLE restaurant_stock_moves (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_type    text NOT NULL CHECK (item_type IN ('supply', 'ingredient')),
  item_id      uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('received', 'used', 'wasted', 'count')),
  delta        numeric(14,2) NOT NULL,
  qty_after    numeric(14,2) NOT NULL,
  unit_cost    numeric(14,2) NOT NULL DEFAULT 0,
  note         text NOT NULL DEFAULT '',
  created_by   uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_stock_moves_item ON restaurant_stock_moves(item_type, item_id, created_at DESC);
CREATE INDEX idx_restaurant_stock_moves_company ON restaurant_stock_moves(company_id, created_at);
