DROP INDEX IF EXISTS idx_restaurant_kitchen_tickets_to_print;
ALTER TABLE restaurant_kitchen_tickets DROP COLUMN IF EXISTS chit_printed_at;
