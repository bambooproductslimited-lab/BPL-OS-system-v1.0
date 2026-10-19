-- The kitchen display (KDS): what the till sends to the kitchen, shown on
-- a screen there (pages/KdsPage.jsx, services/restaurantKitchen.service.js).
--
-- A station is a part of the kitchen with its own screen — "Chinese
-- kitchen", "Bar", "Grill" — cooking the dishes of the menu categories it
-- lists. One may also take "everything else": any dish whose category no
-- station lists. A dish no station takes is not sent to the kitchen at all
-- (bottled drinks, retail), and a restaurant with no stations sends
-- nothing: the kitchen display is off until a station is set up.
CREATE TABLE restaurant_kds_stations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name             text NOT NULL,
  categories       text[] NOT NULL DEFAULT '{}',
  everything_else  boolean NOT NULL DEFAULT false,
  sort_order       integer NOT NULL DEFAULT 0,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

-- A ticket: one round sent from the till — an open table's new dishes
-- when it is kept open, or a sale's when it is charged. Numbered from 1
-- each day per restaurant. Who and where are copied in when it is sent
-- (the open table is gone once paid). cooking → ready (every dish done) →
-- served (taken out); cancelled when every dish on it was taken off the
-- order, shown until a cook clears it (served_at).
CREATE TABLE restaurant_kitchen_tickets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number       integer NOT NULL,
  tab_id       uuid NULL,
  order_id     uuid NULL REFERENCES restaurant_orders(id) ON DELETE SET NULL,
  label        text NOT NULL DEFAULT '',
  table_name   text NULL,
  waiter_name  text NULL,
  guest_name   text NULL,
  note         text NOT NULL DEFAULT '',
  sent_by      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'cooking' CHECK (status IN ('cooking', 'ready', 'served', 'cancelled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  ready_at     timestamptz NULL,
  served_at    timestamptz NULL
);
CREATE INDEX idx_kitchen_tickets_company ON restaurant_kitchen_tickets (company_id, status, created_at);
CREATE INDEX idx_kitchen_tickets_tab ON restaurant_kitchen_tickets (tab_id);
CREATE INDEX idx_kitchen_tickets_order ON restaurant_kitchen_tickets (order_id);

-- A dish on a ticket, for the station that cooks it. Taken off the order
-- after it was sent, it is cancelled (shown struck through, so the cook
-- stops), not deleted.
CREATE TABLE restaurant_kitchen_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id     uuid NOT NULL REFERENCES restaurant_kitchen_tickets(id) ON DELETE CASCADE,
  station_id    uuid NULL REFERENCES restaurant_kds_stations(id) ON DELETE SET NULL,
  menu_item_id  uuid NULL REFERENCES restaurant_menu_items(id) ON DELETE SET NULL,
  variation_id  uuid NULL,
  name          text NOT NULL,
  category      text NOT NULL DEFAULT '',
  qty           numeric NOT NULL CHECK (qty > 0),
  status        text NOT NULL DEFAULT 'cooking' CHECK (status IN ('cooking', 'done', 'cancelled')),
  done_at       timestamptz NULL,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_kitchen_items_ticket ON restaurant_kitchen_items (ticket_id);
CREATE INDEX idx_kitchen_items_station ON restaurant_kitchen_items (station_id, status);
