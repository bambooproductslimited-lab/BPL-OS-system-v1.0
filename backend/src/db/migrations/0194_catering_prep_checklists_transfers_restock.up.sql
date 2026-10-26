-- The thirteenth batch.
--
-- 1. Catering on the restaurant websites (restaurantOnline): party trays
--    (a dish that serves this many: on the catering menu only), ordered days
--    or weeks ahead for a number of guests. A catering order is a website
--    order for later; it is not counted in the 15-minute order limits.
ALTER TABLE restaurant_menu_items ADD COLUMN serves integer NOT NULL DEFAULT 0 CHECK (serves >= 0 AND serves <= 1000);
ALTER TABLE restaurant_online_orders ADD COLUMN catering boolean NOT NULL DEFAULT false;
ALTER TABLE restaurant_online_orders ADD COLUMN guests integer CHECK (guests IS NULL OR guests BETWEEN 1 AND 5000);
CREATE INDEX idx_restaurant_online_orders_catering ON restaurant_online_orders(company_id, scheduled_for) WHERE catering;

-- 2. The kitchen's prep list (restaurantPrep.service): what is expected of
--    each dish a day (the usual for that weekday, and what is ordered ahead)
--    and the ingredients it takes. Ticked off as it is made.
CREATE TABLE restaurant_prep_settings (
  company_id    uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  weeks         integer NOT NULL DEFAULT 4 CHECK (weeks BETWEEN 1 AND 12),
  buffer        integer NOT NULL DEFAULT 10 CHECK (buffer BETWEEN 0 AND 100),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE restaurant_prep_ticks (
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  day           date NOT NULL,
  item_key      text NOT NULL,
  qty           numeric(12,2),
  done_by       uuid REFERENCES employees(id) ON DELETE SET NULL,
  done_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, day, item_key)
);

-- 3. Opening and closing checklists on the till (restaurantChecklists
--    .service): a manager's lists of things to do (a tick) or to read (a
--    number, with the range it should be in: the fridge 0 to 5 °C); staff
--    go through them each day. items: [{ key, text, kind: tick|reading,
--    unit, min, max }]; a run's items: { key: { done, value, bad, by, at } }.
CREATE TABLE restaurant_checklists (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          text NOT NULL,
  at            text NOT NULL DEFAULT 'open' CHECK (at IN ('open', 'close', 'any')),
  items         jsonb NOT NULL DEFAULT '[]',
  active        boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_checklists_company ON restaurant_checklists(company_id) WHERE active;
CREATE TABLE restaurant_checklist_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  checklist_id  uuid NOT NULL REFERENCES restaurant_checklists(id) ON DELETE CASCADE,
  day           date NOT NULL,
  items         jsonb NOT NULL DEFAULT '{}',
  finished_at   timestamptz,
  finished_by   uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (checklist_id, day)
);
CREATE INDEX idx_restaurant_checklist_runs_day ON restaurant_checklist_runs(company_id, day DESC);

-- 4. Stock sent from one restaurant to another (restaurantTransfers
--    .service): off the sender's stock when sent, onto the other's when it
--    is counted in. lines: [{ type: ingredient|supply, id, name, unit, qty,
--    unitCost, receivedQty, toId }].
ALTER TABLE restaurant_stock_moves DROP CONSTRAINT restaurant_stock_moves_kind_check;
ALTER TABLE restaurant_stock_moves ADD CONSTRAINT restaurant_stock_moves_kind_check
  CHECK (kind IN ('received', 'used', 'wasted', 'count', 'sold', 'voided', 'transfer_out', 'transfer_in'));
CREATE TABLE restaurant_stock_transfers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        integer NOT NULL,
  from_company  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  to_company    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'received', 'cancelled')),
  lines         jsonb NOT NULL DEFAULT '[]',
  value         numeric(12,2) NOT NULL DEFAULT 0,
  note          text NOT NULL DEFAULT '',
  sent_by       uuid REFERENCES employees(id) ON DELETE SET NULL,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  received_by   uuid REFERENCES employees(id) ON DELETE SET NULL,
  received_at   timestamptz,
  received_note text NOT NULL DEFAULT '',
  CHECK (from_company <> to_company),
  UNIQUE (from_company, number)
);
CREATE INDEX idx_restaurant_stock_transfers_to ON restaurant_stock_transfers(to_company, status);
CREATE INDEX idx_restaurant_stock_transfers_from ON restaurant_stock_transfers(from_company, sent_at DESC);

-- 5. The online shop's "Tell me when it's back" (shopRestock.service): an
--    item staff mark sold out (or whose stock items all ran out) takes a
--    phone or an email; told once, when it is back.
ALTER TABLE catalog_items ADD COLUMN shop_sold_out boolean NOT NULL DEFAULT false;
CREATE TABLE shop_stock_alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       uuid NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  name          text NOT NULL DEFAULT '',
  phone         text NOT NULL DEFAULT '',
  email         text NOT NULL DEFAULT '',
  ip            text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  notified_at   timestamptz,
  notified_by   text NOT NULL DEFAULT ''
);
CREATE INDEX idx_shop_stock_alerts_waiting ON shop_stock_alerts(item_id) WHERE notified_at IS NULL;
