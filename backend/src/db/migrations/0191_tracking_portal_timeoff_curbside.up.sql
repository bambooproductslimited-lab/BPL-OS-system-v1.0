-- The tenth batch.

-- The shop: delivery priced by area, the order's own page to follow it
-- (shop.service.js): being made, ready, on its way, with when each came;
-- and paid before it is placed (unpaid until its invoice is paid).
ALTER TABLE shop_orders
  ADD COLUMN token text NULL UNIQUE,
  ADD COLUMN area text NOT NULL DEFAULT '',
  ADD COLUMN delivery_fee numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN steps jsonb NOT NULL DEFAULT '{}';
ALTER TABLE shop_orders DROP CONSTRAINT IF EXISTS shop_orders_status_check;
ALTER TABLE shop_orders ADD CONSTRAINT shop_orders_status_check CHECK (status IN ('unpaid', 'new', 'making', 'ready', 'out', 'done', 'cancelled'));

-- "My account" on Bamboo Products' website (portal.service.js): a code sent
-- to an email or a phone, then a session that sees that customer's own
-- orders, invoices, quotations, bookings and contracts.
CREATE TABLE portal_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('email', 'phone')),
  address     text NOT NULL,
  code_hash   text NOT NULL,
  tries       smallint NOT NULL DEFAULT 0,
  used_at     timestamptz NULL,
  expires_at  timestamptz NOT NULL,
  ip          text NOT NULL DEFAULT '',
  signup      jsonb NULL,                  -- a new account's name and phone or email, made once the code is right
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_portal_codes_address ON portal_codes (kind, address, created_at DESC);
CREATE TABLE portal_sessions (
  token_hash  text PRIMARY KEY,
  kind        text NOT NULL,
  address     text NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Time off and availability on the till (restaurantRota.service.js): days
-- off asked for and decided by a manager; the weekdays someone cannot work.
CREATE TABLE restaurant_time_off (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  starts_on    date NOT NULL,
  ends_on      date NOT NULL CHECK (ends_on >= starts_on),
  reason       text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'declined', 'cancelled')),
  decided_by   uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  decided_at   timestamptz NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_time_off ON restaurant_time_off (company_id, status, starts_on);
CREATE TABLE restaurant_availability (
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  days_off     smallint[] NOT NULL DEFAULT '{}',
  note         text NOT NULL DEFAULT '',
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, employee_id)
);

-- Curbside pickup (restaurantOnline.service.js): the customer says they are
-- outside, with a word about their car; the till brings it out.
ALTER TABLE restaurant_online_orders
  ADD COLUMN here_at timestamptz NULL,
  ADD COLUMN here_note text NOT NULL DEFAULT '',
  ADD COLUMN brought_at timestamptz NULL,
  ADD COLUMN brought_by uuid NULL REFERENCES employees(id) ON DELETE SET NULL;
