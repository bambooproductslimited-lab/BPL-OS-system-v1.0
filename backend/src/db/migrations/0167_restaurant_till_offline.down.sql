DROP INDEX IF EXISTS ux_restaurant_open_tabs_client_ref;
ALTER TABLE restaurant_open_tabs DROP COLUMN IF EXISTS client_ref;
DROP INDEX IF EXISTS ux_restaurant_orders_client_ref;
ALTER TABLE restaurant_orders DROP COLUMN IF EXISTS offline_at, DROP COLUMN IF EXISTS client_ref;
