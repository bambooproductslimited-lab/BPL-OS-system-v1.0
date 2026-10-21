ALTER TABLE restaurant_stock_moves DROP COLUMN IF EXISTS order_id;
DELETE FROM restaurant_stock_moves WHERE item_type = 'menu' OR kind IN ('sold', 'voided');
ALTER TABLE restaurant_stock_moves DROP CONSTRAINT restaurant_stock_moves_kind_check;
ALTER TABLE restaurant_stock_moves ADD CONSTRAINT restaurant_stock_moves_kind_check CHECK (kind IN ('received', 'used', 'wasted', 'count'));
ALTER TABLE restaurant_stock_moves DROP CONSTRAINT restaurant_stock_moves_item_type_check;
ALTER TABLE restaurant_stock_moves ADD CONSTRAINT restaurant_stock_moves_item_type_check CHECK (item_type IN ('supply', 'ingredient'));
ALTER TABLE restaurant_menu_items DROP COLUMN IF EXISTS low_stock, DROP COLUMN IF EXISTS stock_qty, DROP COLUMN IF EXISTS track_stock;
DROP TABLE IF EXISTS restaurant_disputes;
DROP TABLE IF EXISTS restaurant_kds_screens;
