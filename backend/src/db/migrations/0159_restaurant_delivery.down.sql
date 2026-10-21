DELETE FROM restaurant_activity WHERE app IN ('delivery', 'online');
ALTER TABLE restaurant_activity DROP CONSTRAINT restaurant_activity_app_check;
ALTER TABLE restaurant_activity ADD CONSTRAINT restaurant_activity_app_check CHECK (app IN ('till', 'kds', 'settings'));
DROP TABLE IF EXISTS restaurant_deliveries;
DROP TABLE IF EXISTS restaurant_online_orders;
DROP TABLE IF EXISTS restaurant_riders;
DROP TABLE IF EXISTS restaurant_delivery_settings;
