-- Ordering from the table (restaurantTableOrders): each table's QR code
-- (qr_token, printed from the till settings) opens the menu on the
-- customer's phone. What they send waits on the till to be accepted onto
-- the table's open order (and the kitchen), or goes straight there if the
-- restaurant says so; they follow it on the same page (token_hash), and can
-- call the waiter or ask for the bill (restaurant_table_calls).
ALTER TABLE restaurant_tables ADD COLUMN qr_token text NULL UNIQUE;

CREATE TABLE restaurant_table_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  table_id          uuid NOT NULL REFERENCES restaurant_tables(id) ON DELETE CASCADE,
  number            integer NOT NULL,
  token_hash        text NOT NULL UNIQUE,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  customer_name     text NOT NULL DEFAULT '',
  note              text NOT NULL DEFAULT '',
  items             jsonb NOT NULL,
  subtotal          numeric(12,2) NOT NULL,
  tab_id            uuid NULL,
  kitchen_ticket_id uuid NULL REFERENCES restaurant_kitchen_tickets(id) ON DELETE SET NULL,
  reject_reason     text NULL,
  decided_by        uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  decided_at        timestamptz NULL,
  ip                text NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, number)
);
CREATE INDEX idx_table_orders_company ON restaurant_table_orders (company_id, status, created_at);
CREATE INDEX idx_table_orders_table ON restaurant_table_orders (table_id, created_at);

CREATE TABLE restaurant_table_calls (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  table_id    uuid NOT NULL REFERENCES restaurant_tables(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('waiter', 'bill')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz NULL,
  answered_by uuid NULL REFERENCES employees(id) ON DELETE SET NULL
);
CREATE INDEX idx_table_calls_open ON restaurant_table_calls (company_id, created_at) WHERE answered_at IS NULL;
