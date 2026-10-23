-- Bookings and the waitlist (restaurantBookings.service.js): a table booked
-- for a time (from the till, or asked for on the website and confirmed by
-- the restaurant), and walk-ins waiting for a table, told roughly how long
-- and texted when it is ready. A booking holds its table for its minutes;
-- the floor map shows it coming. Seated, it becomes an order on the till.
CREATE TABLE restaurant_bookings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('booking', 'waitlist')),
  status          text NOT NULL CHECK (status IN ('requested', 'booked', 'waiting', 'called', 'seated', 'cancelled', 'no_show', 'declined')),
  name            text NOT NULL,
  phone           text NOT NULL DEFAULT '',
  party           smallint NOT NULL CHECK (party BETWEEN 1 AND 200),
  -- When they are expected (a booking) or joined the list (the waitlist).
  at              timestamptz NOT NULL,
  minutes         smallint NOT NULL DEFAULT 90 CHECK (minutes BETWEEN 15 AND 600),
  quoted_minutes  smallint NULL CHECK (quoted_minutes IS NULL OR quoted_minutes BETWEEN 0 AND 600),
  table_id        uuid NULL REFERENCES restaurant_tables(id) ON DELETE SET NULL,
  note            text NOT NULL DEFAULT '',
  source          text NOT NULL DEFAULT 'till' CHECK (source IN ('till', 'website')),
  -- A website booking's own link (to see it, or cancel it).
  token           text NULL UNIQUE,
  account_id      uuid NULL REFERENCES restaurant_customer_accounts(id) ON DELETE SET NULL,
  -- Texts sent about it: [{ what: 'confirmed' | 'ready' | 'declined', channel, at }].
  texted          jsonb NOT NULL DEFAULT '[]',
  called_at       timestamptz NULL,
  seated_at       timestamptz NULL,
  created_by      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_bookings_day ON restaurant_bookings (company_id, at);
CREATE INDEX idx_restaurant_bookings_table ON restaurant_bookings (table_id, at) WHERE table_id IS NOT NULL;
