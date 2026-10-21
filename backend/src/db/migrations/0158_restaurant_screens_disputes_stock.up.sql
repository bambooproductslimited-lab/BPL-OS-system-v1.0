-- The till's back office (restaurantKdsScreens.service.js,
-- restaurantDisputes.service.js, restaurantTillMenu.service.js):
--
-- 1. Kitchen screens (restaurant_kds_screens): a tablet that opens the
--    kitchen screen link is unknown until a manager sets it up. It shows a
--    short code and waits (status 'waiting', no restaurant yet); a manager
--    of the restaurant claims it in the till settings — by its code, or
--    picked from the screens waiting on the same network — names it and
--    gives it its station (none: every station). The tablet keeps a secret
--    token (only its hash is stored); cooks then sign in on it with their
--    own PIN, so the screen's station is fixed and we know who cooked.
-- 2. Disputes (restaurant_disputes): a customer's complaint about an order,
--    a wrong charge, or a drawer counted short (opened by itself when a
--    drawer closes short), from raised to resolved — how (refunded, made
--    again, discounted, written off, nothing to do) and by whom.
-- 3. Stock on the menu: a dish or drink can count its stock (bottles,
--    portions). A sale takes it off; a manager counts it or adds what came
--    in. The moves join the supplies' and ingredients' history
--    (restaurant_stock_moves, item_type 'menu'), with 'sold' and 'voided'.

CREATE TABLE restaurant_kds_screens (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid REFERENCES companies(id) ON DELETE CASCADE,
  name           text NOT NULL DEFAULT '',
  station_id     uuid REFERENCES restaurant_kds_stations(id) ON DELETE SET NULL,
  code           text NOT NULL,
  token_hash     text NOT NULL UNIQUE,
  status         text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'active')),
  device         text NOT NULL DEFAULT '',
  ip             text NOT NULL DEFAULT '',
  signed_in_id   uuid REFERENCES employees(id) ON DELETE SET NULL,
  signed_in_at   timestamptz,
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  claimed_by     uuid REFERENCES employees(id) ON DELETE SET NULL,
  claimed_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_kds_screens_company ON restaurant_kds_screens(company_id) WHERE company_id IS NOT NULL;
CREATE INDEX idx_restaurant_kds_screens_waiting ON restaurant_kds_screens(code) WHERE status = 'waiting';

CREATE TABLE restaurant_disputes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('complaint', 'wrong_charge', 'drawer_short', 'other')),
  order_id           uuid REFERENCES restaurant_orders(id) ON DELETE SET NULL,
  tab_id             uuid,
  drawer_session_id  uuid REFERENCES restaurant_drawer_sessions(id) ON DELETE SET NULL,
  amount             numeric(12,2) CHECK (amount IS NULL OR amount >= 0),
  description        text NOT NULL DEFAULT '',
  customer_name      text NOT NULL DEFAULT '',
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution         text CHECK (resolution IS NULL OR resolution IN ('refunded', 'remade', 'discounted', 'written_off', 'no_action', 'other')),
  resolution_note    text NOT NULL DEFAULT '',
  opened_by          uuid REFERENCES employees(id) ON DELETE SET NULL,
  resolved_by        uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz
);
CREATE INDEX idx_restaurant_disputes_company ON restaurant_disputes(company_id, status, created_at DESC);

ALTER TABLE restaurant_menu_items
  ADD COLUMN track_stock boolean NOT NULL DEFAULT false,
  ADD COLUMN stock_qty numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN low_stock numeric(14,2) NOT NULL DEFAULT 0;

ALTER TABLE restaurant_stock_moves DROP CONSTRAINT restaurant_stock_moves_item_type_check;
ALTER TABLE restaurant_stock_moves ADD CONSTRAINT restaurant_stock_moves_item_type_check CHECK (item_type IN ('supply', 'ingredient', 'menu'));
ALTER TABLE restaurant_stock_moves DROP CONSTRAINT restaurant_stock_moves_kind_check;
ALTER TABLE restaurant_stock_moves ADD CONSTRAINT restaurant_stock_moves_kind_check CHECK (kind IN ('received', 'used', 'wasted', 'count', 'sold', 'voided'));
ALTER TABLE restaurant_stock_moves ADD COLUMN order_id uuid REFERENCES restaurant_orders(id) ON DELETE SET NULL;
