UPDATE restaurant_open_tabs SET fulfillment = 'pickup' WHERE fulfillment = 'togo';
UPDATE restaurant_orders SET fulfillment = 'pickup' WHERE fulfillment = 'togo';
UPDATE restaurant_kitchen_tickets SET fulfillment = 'pickup' WHERE fulfillment = 'togo';
ALTER TABLE restaurant_open_tabs DROP CONSTRAINT restaurant_open_tabs_fulfillment_check;
ALTER TABLE restaurant_open_tabs ADD CONSTRAINT restaurant_open_tabs_fulfillment_check CHECK (fulfillment IN ('dine_in', 'pickup', 'delivery'));
