-- Deliveries, and orders from the restaurant's own website
-- (restaurantDelivery.service.js, restaurantOnline.service.js).
--
-- A delivery is made when the food goes out with a rider: one of the
-- restaurant's riders, or someone whose name and phone the cashier types.
-- The rider follows it on a link (rider_token_hash) that shares where they
-- are; the customer of a website order follows it on theirs.

-- The restaurant's delivery settings: where it is, whether it takes orders
-- online now, the delivery fee, how far it goes.
CREATE TABLE restaurant_delivery_settings (
  company_id  uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  settings    jsonb NOT NULL DEFAULT '{}',
  updated_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE restaurant_riders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  phone       text NOT NULL DEFAULT '',
  vehicle     text NOT NULL DEFAULT 'motorbike' CHECK (vehicle IN ('motorbike', 'bicycle', 'car', 'on_foot')),
  plate       text NOT NULL DEFAULT '',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_riders_company ON restaurant_riders (company_id, active);

-- An order a customer placed on the website: waiting for the restaurant
-- to accept it (pending), then an open order on the till (tab_id) cooked
-- and sent out like any other; or rejected, or cancelled by the customer
-- while it waited. Done once paid at the till.
CREATE TABLE restaurant_online_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number         integer NOT NULL,
  token_hash     text NOT NULL UNIQUE,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled', 'done')),
  fulfillment    text NOT NULL DEFAULT 'delivery' CHECK (fulfillment IN ('delivery', 'pickup')),
  customer_name  text NOT NULL,
  customer_phone text NOT NULL,
  address        text NOT NULL DEFAULT '',
  landmark       text NOT NULL DEFAULT '',
  lat            double precision NULL,
  lng            double precision NULL,
  note           text NOT NULL DEFAULT '',
  pay_method     text NOT NULL DEFAULT 'cash' CHECK (pay_method IN ('cash', 'mobile_money')),
  items          jsonb NOT NULL,
  subtotal       numeric(12,2) NOT NULL,
  delivery_fee   numeric(12,2) NOT NULL DEFAULT 0,
  total          numeric(12,2) NOT NULL,
  distance_km    numeric(8,2) NULL,
  ready_minutes  integer NULL,
  reject_reason  text NULL,
  tab_id         uuid NULL,
  order_id       uuid NULL REFERENCES restaurant_orders(id) ON DELETE SET NULL,
  ip             text NULL,
  decided_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  decided_at     timestamptz NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_online_orders_company ON restaurant_online_orders (company_id, status, created_at);
CREATE INDEX idx_online_orders_phone ON restaurant_online_orders (customer_phone, created_at);
CREATE INDEX idx_online_orders_tab ON restaurant_online_orders (tab_id);

CREATE TABLE restaurant_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number           integer NOT NULL,
  status           text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned', 'picked_up', 'arrived', 'delivered', 'failed', 'cancelled')),
  source           text NOT NULL DEFAULT 'till' CHECK (source IN ('till', 'online')),
  tab_id           uuid NULL,
  order_id         uuid NULL REFERENCES restaurant_orders(id) ON DELETE SET NULL,
  ticket_id        uuid NULL REFERENCES restaurant_kitchen_tickets(id) ON DELETE SET NULL,
  online_order_id  uuid NULL REFERENCES restaurant_online_orders(id) ON DELETE SET NULL,
  label            text NOT NULL DEFAULT '',
  customer_name    text NOT NULL DEFAULT '',
  customer_phone   text NOT NULL DEFAULT '',
  address          text NOT NULL DEFAULT '',
  landmark         text NOT NULL DEFAULT '',
  lat              double precision NULL,
  lng              double precision NULL,
  items            jsonb NOT NULL DEFAULT '[]',
  to_collect       numeric(12,2) NOT NULL DEFAULT 0,
  collect_method   text NULL CHECK (collect_method IN ('cash', 'mobile_money')),
  rider_id         uuid NULL REFERENCES restaurant_riders(id) ON DELETE SET NULL,
  rider_name       text NOT NULL,
  rider_phone      text NOT NULL DEFAULT '',
  rider_vehicle    text NOT NULL DEFAULT 'motorbike',
  rider_plate      text NOT NULL DEFAULT '',
  rider_token_hash text NOT NULL UNIQUE,
  rider_token_sealed text NOT NULL,
  rider_lat        double precision NULL,
  rider_lng        double precision NULL,
  rider_seen_at    timestamptz NULL,
  distance_km      numeric(8,2) NULL,
  eta_minutes      integer NULL,
  note             text NOT NULL DEFAULT '',
  sent_by          uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  picked_up_at     timestamptz NULL,
  arrived_at       timestamptz NULL,
  ended_at         timestamptz NULL
);
CREATE INDEX idx_deliveries_company ON restaurant_deliveries (company_id, status, created_at);
CREATE INDEX idx_deliveries_rider ON restaurant_deliveries (rider_id, status);
CREATE INDEX idx_deliveries_tab ON restaurant_deliveries (tab_id);
CREATE INDEX idx_deliveries_order ON restaurant_deliveries (order_id);
CREATE INDEX idx_deliveries_online ON restaurant_deliveries (online_order_id);

-- The delivery screen and the website write to the activity log too.
ALTER TABLE restaurant_activity DROP CONSTRAINT restaurant_activity_app_check;
ALTER TABLE restaurant_activity ADD CONSTRAINT restaurant_activity_app_check CHECK (app IN ('till', 'kds', 'settings', 'delivery', 'online'));
