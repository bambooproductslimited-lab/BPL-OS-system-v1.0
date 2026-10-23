DROP TABLE IF EXISTS restaurant_tip_payouts;
DROP INDEX IF EXISTS idx_restaurant_paystack_tab;
DELETE FROM restaurant_paystack_payments WHERE purpose = 'table';
ALTER TABLE restaurant_paystack_payments DROP COLUMN IF EXISTS payer, DROP COLUMN IF EXISTS tip, DROP COLUMN IF EXISTS tab_id;
ALTER TABLE restaurant_paystack_payments DROP CONSTRAINT restaurant_paystack_payments_purpose_check;
ALTER TABLE restaurant_paystack_payments ADD CONSTRAINT restaurant_paystack_payments_purpose_check CHECK (purpose IN ('till', 'kiosk'));
