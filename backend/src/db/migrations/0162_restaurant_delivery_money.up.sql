-- The money on a delivery (restaurantDelivery): what the rider says they
-- collected at the door, and what the cashier took from them on the till —
-- the open order charged into their drawer (handIn).
ALTER TABLE restaurant_deliveries
  ADD COLUMN collected_amount numeric(12,2) NULL CHECK (collected_amount >= 0),
  ADD COLUMN collected_method text NULL CHECK (collected_method IN ('cash', 'mobile_money')),
  ADD COLUMN collected_at timestamptz NULL,
  ADD COLUMN collected_note text NOT NULL DEFAULT '',
  ADD COLUMN handed_amount numeric(12,2) NULL CHECK (handed_amount >= 0),
  ADD COLUMN handed_method text NULL,
  ADD COLUMN handed_at timestamptz NULL,
  ADD COLUMN handed_by uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  ADD COLUMN handed_note text NOT NULL DEFAULT '';

-- Money still with a rider, quickly.
CREATE INDEX restaurant_deliveries_to_hand_in ON restaurant_deliveries (company_id) WHERE collected_at IS NOT NULL AND handed_at IS NULL;

-- A rider handing in less than the order came to is a dispute of its own.
ALTER TABLE restaurant_disputes DROP CONSTRAINT restaurant_disputes_kind_check;
ALTER TABLE restaurant_disputes ADD CONSTRAINT restaurant_disputes_kind_check CHECK (kind IN ('complaint', 'wrong_charge', 'drawer_short', 'rider_short', 'other'));
