-- Website orders for later (restaurantOnline): the customer picks when they
-- want it (delivered at, or ready to pick up at). Confirmed by the
-- restaurant, it waits until start_at — the time to start cooking — and
-- only then becomes an open order on the till, sent to the kitchen
-- (release, by the onlineScheduled job or the delivery screen). Why it
-- could not be started, if it could not, for the delivery screen.
ALTER TABLE restaurant_online_orders
  ADD COLUMN scheduled_for timestamptz NULL,
  ADD COLUMN start_at timestamptz NULL,
  ADD COLUMN release_error text NULL;
CREATE INDEX idx_online_orders_start ON restaurant_online_orders (start_at) WHERE status = 'accepted' AND tab_id IS NULL;
