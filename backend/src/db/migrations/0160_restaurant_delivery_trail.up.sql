-- The way a rider actually went, from their phone (restaurantDelivery
-- riderLocation): [[lat, lng], …] in order, a point each time they have
-- moved on, drawn on the maps while the delivery is under way.
ALTER TABLE restaurant_deliveries ADD COLUMN rider_trail jsonb NOT NULL DEFAULT '[]'::jsonb;
