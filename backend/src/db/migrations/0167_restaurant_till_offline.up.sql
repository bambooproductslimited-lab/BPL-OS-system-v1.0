-- The till keeps working without the internet (restaurantPos createOrder,
-- saveTabFor): a sale or an order sent to the kitchen while offline is kept
-- on the till and sent when the connection is back, each with a reference
-- of its own (client_ref) so sending it twice makes it once; a sale taken
-- offline keeps when it was taken (offline_at).
ALTER TABLE restaurant_orders ADD COLUMN client_ref text NULL, ADD COLUMN offline_at timestamptz NULL;
CREATE UNIQUE INDEX ux_restaurant_orders_client_ref ON restaurant_orders (company_id, client_ref) WHERE client_ref IS NOT NULL;
ALTER TABLE restaurant_open_tabs ADD COLUMN client_ref text NULL;
CREATE UNIQUE INDEX ux_restaurant_open_tabs_client_ref ON restaurant_open_tabs (company_id, client_ref) WHERE client_ref IS NOT NULL;
