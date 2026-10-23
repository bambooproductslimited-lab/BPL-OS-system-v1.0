DROP INDEX IF EXISTS idx_restaurant_online_orders_account;
ALTER TABLE restaurant_online_orders DROP COLUMN IF EXISTS account_id;
DROP TABLE IF EXISTS restaurant_customer_accounts;
