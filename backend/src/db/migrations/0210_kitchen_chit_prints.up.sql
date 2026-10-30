-- Kitchen tickets printed at the kitchen's printer (restaurantKitchen
-- printQueue). A ticket the till sent itself is printed by that till as it
-- goes, and marked then; one that reached the kitchen without a tap at the
-- till (a website order, a kiosk or table QR order sent straight on, an
-- order for later reaching its time) waits until a till with a kitchen
-- printer prints it. The tickets there already count as printed.
ALTER TABLE restaurant_kitchen_tickets ADD COLUMN chit_printed_at timestamptz NULL;
UPDATE restaurant_kitchen_tickets SET chit_printed_at = now();
CREATE INDEX idx_restaurant_kitchen_tickets_to_print ON restaurant_kitchen_tickets (company_id, created_at) WHERE chit_printed_at IS NULL;
