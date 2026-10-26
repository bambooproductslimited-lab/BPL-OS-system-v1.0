-- The fourteenth batch.
--
-- Settings of the till's newer parts, each its own jsonb under a name
-- (cashOffice, events), so a new part needs no change to the till's own
-- settings document.
CREATE TABLE restaurant_more_settings (
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  value       jsonb NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, name)
);

-- The cash office (restaurantCashOffice.service). Money out of a drawer is
-- a paid-out as before (paid), cash put in the safe (drop) or petty cash
-- spent (petty: its category, who it went to, the receipt's photo); money
-- in can be an event's deposit taken at the till (event).
ALTER TABLE restaurant_drawer_movements ADD COLUMN kind text NOT NULL DEFAULT 'paid' CHECK (kind IN ('paid', 'drop', 'petty', 'event'));
ALTER TABLE restaurant_drawer_movements ADD COLUMN category text NOT NULL DEFAULT '';
ALTER TABLE restaurant_drawer_movements ADD COLUMN paid_to text NOT NULL DEFAULT '';
ALTER TABLE restaurant_drawer_movements ADD COLUMN photo jsonb NULL;
ALTER TABLE restaurant_drawer_movements ADD COLUMN by_id uuid NULL REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE restaurant_drawer_movements ADD COLUMN approved_by uuid NULL REFERENCES employees(id) ON DELETE SET NULL;

-- The safe: cash dropped in from the drawers, taken to the bank (the
-- slip's bank, number and photo), and counted (what it held against what
-- it should have). What it holds: the last count, plus drops since, less
-- deposits since.
CREATE TABLE restaurant_safe_moves (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('drop', 'deposit', 'count')),
  amount       numeric NOT NULL CHECK (amount >= 0),
  expected     numeric NULL,
  movement_id  uuid NULL REFERENCES restaurant_drawer_movements(id) ON DELETE SET NULL,
  bank         text NOT NULL DEFAULT '',
  reference    text NOT NULL DEFAULT '',
  photo        jsonb NULL,
  note         text NOT NULL DEFAULT '',
  by_id        uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  witness_id   uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_safe_moves ON restaurant_safe_moves (company_id, created_at);

-- Private events and room hire (restaurantEvents.service): asked for on the
-- website or written on the till; a set menu for so much a guest, extras
-- (the room, decorations), a deposit, and the day's plan hour by hour.
CREATE TABLE restaurant_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number          integer NOT NULL,
  token           text NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'enquiry' CHECK (status IN ('enquiry', 'quoted', 'confirmed', 'done', 'cancelled')),
  source          text NOT NULL DEFAULT 'till' CHECK (source IN ('till', 'website')),
  name            text NOT NULL,
  phone           text NOT NULL DEFAULT '',
  email           text NOT NULL DEFAULT '',
  occasion        text NOT NULL DEFAULT '',
  space           text NOT NULL DEFAULT '',
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  guests          integer NOT NULL CHECK (guests BETWEEN 1 AND 2000),
  -- [{ menuItemId, name, perGuest }] — portions for each guest.
  menu            jsonb NOT NULL DEFAULT '[]',
  per_head        numeric NOT NULL DEFAULT 0 CHECK (per_head >= 0),
  -- [{ text, amount }]
  extras          jsonb NOT NULL DEFAULT '[]',
  total           numeric NOT NULL DEFAULT 0,
  deposit_amount  numeric NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
  deposit_status  text NOT NULL DEFAULT 'none' CHECK (deposit_status IN ('none', 'due', 'paid', 'refunded')),
  deposit_method  text NOT NULL DEFAULT '',
  deposit_paid_at timestamptz NULL,
  -- [{ time: 'HH:MM', text, who: 'all' | 'kitchen' | 'floor' | 'bar' }]
  plan            jsonb NOT NULL DEFAULT '[]',
  note            text NOT NULL DEFAULT '',
  staff_note      text NOT NULL DEFAULT '',
  ip              text NOT NULL DEFAULT '',
  texted          jsonb NOT NULL DEFAULT '[]',
  created_by      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, number),
  CHECK (ends_at > starts_at)
);
CREATE INDEX idx_restaurant_events_day ON restaurant_events (company_id, starts_at);

ALTER TABLE restaurant_paystack_payments DROP CONSTRAINT restaurant_paystack_payments_purpose_check;
ALTER TABLE restaurant_paystack_payments ADD CONSTRAINT restaurant_paystack_payments_purpose_check CHECK (purpose IN ('till', 'kiosk', 'table', 'gift', 'online', 'deposit', 'event'));
ALTER TABLE restaurant_paystack_payments ADD COLUMN event_id uuid NULL REFERENCES restaurant_events(id) ON DELETE SET NULL;

-- Menu boards (restaurantMenuBoards.service): a TV paired like the ready
-- board, showing the categories chosen ({ categories, title, layout,
-- rotate, photos, ready }).
ALTER TABLE restaurant_displays DROP CONSTRAINT restaurant_displays_kind_check;
ALTER TABLE restaurant_displays ADD CONSTRAINT restaurant_displays_kind_check CHECK (kind IN ('screen', 'kiosk', 'board', 'menu'));
ALTER TABLE restaurant_displays ADD COLUMN options jsonb NOT NULL DEFAULT '{}';

-- Bamboo Products: deliveries, fitting and repairs (bplVisits.service).
-- Settings: { warrantyMonths, windows: ['08:00-12:00', …], repairs }.
ALTER TABLE settings ADD COLUMN visits jsonb NOT NULL DEFAULT '{}';

-- Something wrong with what a customer bought: asked for from their order's
-- page (or written by staff), with photos; staff decide if it is under
-- warranty, and send someone round.
CREATE TABLE bpl_service_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number         integer NOT NULL UNIQUE,
  token          text NOT NULL UNIQUE,
  shop_order_id  uuid NULL REFERENCES shop_orders(id) ON DELETE SET NULL,
  customer_id    uuid NULL REFERENCES customers(id) ON DELETE SET NULL,
  name           text NOT NULL,
  phone          text NOT NULL DEFAULT '',
  email          text NOT NULL DEFAULT '',
  address        text NOT NULL DEFAULT '',
  item           text NOT NULL DEFAULT '',
  problem        text NOT NULL,
  photos         jsonb NOT NULL DEFAULT '[]',
  warranty       boolean NULL,
  status         text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'visit', 'fixed', 'closed')),
  answer         text NOT NULL DEFAULT '',
  ip             text NOT NULL DEFAULT '',
  created_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_bpl_service_requests_status ON bpl_service_requests (status, created_at);

-- A visit: a delivery, a fitting or a repair, on a day in a time window,
-- by a crew; proof when done (who signed, the signature, photos).
CREATE TABLE bpl_visits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          integer NOT NULL UNIQUE,
  kind            text NOT NULL CHECK (kind IN ('delivery', 'install', 'repair')),
  shop_order_id   uuid NULL REFERENCES shop_orders(id) ON DELETE SET NULL,
  sales_order_id  uuid NULL REFERENCES sales_orders(id) ON DELETE SET NULL,
  service_id      uuid NULL REFERENCES bpl_service_requests(id) ON DELETE SET NULL,
  name            text NOT NULL,
  phone           text NOT NULL DEFAULT '',
  email           text NOT NULL DEFAULT '',
  address         text NOT NULL DEFAULT '',
  area            text NOT NULL DEFAULT '',
  day             date NOT NULL,
  time_from       text NOT NULL,
  time_to         text NOT NULL,
  crew            uuid[] NOT NULL DEFAULT '{}',
  vehicle         text NOT NULL DEFAULT '',
  -- [{ description, qty }]: what goes on the van.
  items           jsonb NOT NULL DEFAULT '[]',
  note            text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'on_way', 'arrived', 'done', 'failed', 'cancelled')),
  steps           jsonb NOT NULL DEFAULT '{}',
  signed_name     text NOT NULL DEFAULT '',
  signature       jsonb NULL,
  photos          jsonb NOT NULL DEFAULT '[]',
  outcome         text NOT NULL DEFAULT '',
  texted          jsonb NOT NULL DEFAULT '[]',
  created_by      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  done_by         uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_bpl_visits_day ON bpl_visits (day, time_from);
CREATE INDEX idx_bpl_visits_shop_order ON bpl_visits (shop_order_id) WHERE shop_order_id IS NOT NULL;
