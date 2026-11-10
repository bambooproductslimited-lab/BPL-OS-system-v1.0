-- Orders taken while the till had no internet (pages/till/tillOffline.js)
-- reach the server when it is back. By then the kitchen has had them: by
-- word of mouth, on a ticket the till printed, or through the print hub on
-- the restaurant's network. Their kitchen tickets are kept for the record,
-- marked with when they were taken, already served: not shown on the
-- kitchen screens or printed again (restaurantKitchen.service.js fire).
ALTER TABLE restaurant_kitchen_tickets ADD COLUMN offline_at timestamptz NULL;
