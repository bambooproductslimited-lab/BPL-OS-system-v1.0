-- The table's service, closer to what a full restaurant till does
-- (restaurantPos.service.js, restaurantKitchen.service.js):
--
-- Courses: each dish of an open order goes in a course (0 right away —
-- drinks —, 1 starters, 2 mains, 3 desserts…). When an order is sent the
-- first course is cooked at once and the later ones wait at the kitchen
-- (a ticket per course, status 'held') until the waiter calls them
-- (fired_at); the open order remembers how far it has been called
-- (fired_course).
--
-- Seats and guests: how many sat down (guests, for the spend per guest),
-- and which seat had a dish (seat), on the open order, the sale and the
-- kitchen's ticket.
--
-- Allergens: what a dish contains (allergens, by key: gluten, peanuts…),
-- and an order's allergy alert ({ list, note }) — the kitchen's ticket
-- carries it in words (allergy) with the keys (allergens), and each dish
-- what it contains, to flag the ones that clash.
--
-- Printed tickets: a station without a screen has its tickets printed at
-- the till when an order is sent (print_tickets).
ALTER TABLE restaurant_menu_items ADD COLUMN allergens text[] NOT NULL DEFAULT '{}';
ALTER TABLE restaurant_open_tabs
  ADD COLUMN guests smallint NULL CHECK (guests IS NULL OR guests BETWEEN 1 AND 200),
  ADD COLUMN fired_course smallint NOT NULL DEFAULT 0,
  ADD COLUMN allergy jsonb NULL;
ALTER TABLE restaurant_orders
  ADD COLUMN guests smallint NULL CHECK (guests IS NULL OR guests BETWEEN 1 AND 200),
  ADD COLUMN allergy jsonb NULL;
ALTER TABLE restaurant_order_items
  ADD COLUMN seat smallint NULL,
  ADD COLUMN course smallint NULL;
ALTER TABLE restaurant_kitchen_tickets
  ADD COLUMN course smallint NOT NULL DEFAULT 0,
  ADD COLUMN fired_at timestamptz NULL,
  ADD COLUMN allergy text NOT NULL DEFAULT '',
  ADD COLUMN allergens text[] NOT NULL DEFAULT '{}',
  ADD COLUMN guests smallint NULL;
ALTER TABLE restaurant_kitchen_tickets DROP CONSTRAINT IF EXISTS restaurant_kitchen_tickets_status_check;
ALTER TABLE restaurant_kitchen_tickets ADD CONSTRAINT restaurant_kitchen_tickets_status_check CHECK (status IN ('held', 'cooking', 'ready', 'served', 'cancelled'));
ALTER TABLE restaurant_kitchen_items
  ADD COLUMN seat smallint NULL,
  ADD COLUMN course smallint NOT NULL DEFAULT 0,
  ADD COLUMN allergens text[] NOT NULL DEFAULT '{}';
ALTER TABLE restaurant_kds_stations ADD COLUMN print_tickets boolean NOT NULL DEFAULT false;
