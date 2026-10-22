DROP TABLE IF EXISTS restaurant_iou_advances;
DELETE FROM restaurant_vip_entries WHERE kind = 'cashout';
ALTER TABLE restaurant_vip_entries DROP COLUMN IF EXISTS approved_by;
ALTER TABLE restaurant_vip_entries DROP CONSTRAINT restaurant_vip_entries_check;
ALTER TABLE restaurant_vip_entries ADD CONSTRAINT restaurant_vip_entries_check CHECK ((kind = 'topup') = (method IS NOT NULL));
ALTER TABLE restaurant_vip_entries DROP CONSTRAINT restaurant_vip_entries_kind_check;
ALTER TABLE restaurant_vip_entries ADD CONSTRAINT restaurant_vip_entries_kind_check CHECK (kind IN ('topup', 'sale', 'refund'));
DROP INDEX IF EXISTS idx_restaurant_vip_entries_cashier;
CREATE INDEX idx_restaurant_vip_entries_cashier ON restaurant_vip_entries(cashier_id, created_at) WHERE kind = 'topup';
