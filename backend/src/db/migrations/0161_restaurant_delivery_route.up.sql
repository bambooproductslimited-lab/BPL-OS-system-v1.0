-- The road a delivery takes, with the traffic on it (Google's Routes API,
-- restaurantRoutes.service.js): { points: [[lat, lng], …], traffic:
-- [[from, to, 'slow'|'jam'], …], seconds, freeSeconds, meters, mode, from:
-- 'restaurant'|'rider', at, startAt, arriveAt }. route_calls counts the
-- times Google was asked for it, so one delivery cannot run the bill up.
ALTER TABLE restaurant_deliveries ADD COLUMN route jsonb NULL;
ALTER TABLE restaurant_deliveries ADD COLUMN route_calls integer NOT NULL DEFAULT 0;
