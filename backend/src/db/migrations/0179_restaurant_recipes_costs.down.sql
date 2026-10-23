ALTER TABLE restaurant_order_items DROP COLUMN IF EXISTS unit_cost;
ALTER TABLE restaurant_menu_item_variations DROP COLUMN IF EXISTS unit_cost;
ALTER TABLE restaurant_menu_items DROP COLUMN IF EXISTS unit_cost;
DROP TABLE IF EXISTS restaurant_recipes;
