-- To go (migration 0202): a fourth kind of order on the till, beside dine
-- in, pickup and delivery — bought at the counter and packed to take away,
-- no table and no phone number needed. Sales and kitchen tickets keep the
-- kind as text already; only the open orders check what it may be.
ALTER TABLE restaurant_open_tabs DROP CONSTRAINT restaurant_open_tabs_fulfillment_check;
ALTER TABLE restaurant_open_tabs ADD CONSTRAINT restaurant_open_tabs_fulfillment_check CHECK (fulfillment IN ('dine_in', 'togo', 'pickup', 'delivery'));
