DELETE FROM restaurant_disputes WHERE kind = 'rider_short';
ALTER TABLE restaurant_disputes DROP CONSTRAINT restaurant_disputes_kind_check;
ALTER TABLE restaurant_disputes ADD CONSTRAINT restaurant_disputes_kind_check CHECK (kind IN ('complaint', 'wrong_charge', 'drawer_short', 'other'));
DROP INDEX IF EXISTS restaurant_deliveries_to_hand_in;
ALTER TABLE restaurant_deliveries
  DROP COLUMN IF EXISTS handed_note, DROP COLUMN IF EXISTS handed_by, DROP COLUMN IF EXISTS handed_at, DROP COLUMN IF EXISTS handed_method, DROP COLUMN IF EXISTS handed_amount,
  DROP COLUMN IF EXISTS collected_note, DROP COLUMN IF EXISTS collected_at, DROP COLUMN IF EXISTS collected_method, DROP COLUMN IF EXISTS collected_amount;
