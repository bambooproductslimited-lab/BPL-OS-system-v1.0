DROP TABLE IF EXISTS shop_stock_alerts;
ALTER TABLE catalog_items DROP COLUMN IF EXISTS shop_sold_out;
DROP TABLE IF EXISTS restaurant_stock_transfers;
DELETE FROM restaurant_stock_moves WHERE kind IN ('transfer_out', 'transfer_in');
ALTER TABLE restaurant_stock_moves DROP CONSTRAINT restaurant_stock_moves_kind_check;
ALTER TABLE restaurant_stock_moves ADD CONSTRAINT restaurant_stock_moves_kind_check
  CHECK (kind IN ('received', 'used', 'wasted', 'count', 'sold', 'voided'));
DROP TABLE IF EXISTS restaurant_checklist_runs;
DROP TABLE IF EXISTS restaurant_checklists;
DROP TABLE IF EXISTS restaurant_prep_ticks;
DROP TABLE IF EXISTS restaurant_prep_settings;
DROP INDEX IF EXISTS idx_restaurant_online_orders_catering;
ALTER TABLE restaurant_online_orders DROP COLUMN IF EXISTS guests;
ALTER TABLE restaurant_online_orders DROP COLUMN IF EXISTS catering;
ALTER TABLE restaurant_menu_items DROP COLUMN IF EXISTS serves;
