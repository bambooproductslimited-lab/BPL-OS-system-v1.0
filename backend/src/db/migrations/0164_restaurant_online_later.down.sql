DROP INDEX IF EXISTS idx_online_orders_start;
ALTER TABLE restaurant_online_orders DROP COLUMN IF EXISTS release_error, DROP COLUMN IF EXISTS start_at, DROP COLUMN IF EXISTS scheduled_for;
