-- The eleventh batch: website orders paid online, booking deposits, unpaid
-- shop checkouts reminded, product reviews, and quote requests.

-- Restaurant payments through Paystack: a website order paid online
-- (online), a booking's deposit (deposit); and given back (refund_*).
ALTER TABLE restaurant_paystack_payments DROP CONSTRAINT restaurant_paystack_payments_purpose_check;
ALTER TABLE restaurant_paystack_payments ADD CONSTRAINT restaurant_paystack_payments_purpose_check CHECK (purpose IN ('till', 'kiosk', 'table', 'gift', 'online', 'deposit'));
ALTER TABLE restaurant_paystack_payments
  ADD COLUMN online_order_id uuid NULL,
  ADD COLUMN booking_id      uuid NULL,
  ADD COLUMN refund_status   text NULL CHECK (refund_status IS NULL OR refund_status IN ('pending', 'processed', 'failed')),
  ADD COLUMN refund_note     text NOT NULL DEFAULT '',
  ADD COLUMN refunded_at     timestamptz NULL;
CREATE INDEX idx_restaurant_paystack_online ON restaurant_paystack_payments (online_order_id) WHERE online_order_id IS NOT NULL;
CREATE INDEX idx_restaurant_paystack_booking ON restaurant_paystack_payments (booking_id) WHERE booking_id IS NOT NULL;

-- A website order paid online waits (unpaid) until it is paid.
ALTER TABLE restaurant_online_orders DROP CONSTRAINT restaurant_online_orders_status_check;
ALTER TABLE restaurant_online_orders ADD CONSTRAINT restaurant_online_orders_status_check CHECK (status IN ('unpaid', 'pending', 'accepted', 'rejected', 'cancelled', 'done'));
ALTER TABLE restaurant_online_orders DROP CONSTRAINT restaurant_online_orders_pay_method_check;
ALTER TABLE restaurant_online_orders ADD CONSTRAINT restaurant_online_orders_pay_method_check CHECK (pay_method IN ('cash', 'mobile_money', 'online'));

-- A booking's deposit: how much, and where it stands.
ALTER TABLE restaurant_bookings
  ADD COLUMN deposit_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN deposit_status text NOT NULL DEFAULT 'none' CHECK (deposit_status IN ('none', 'due', 'paid', 'applied', 'kept', 'refunded', 'refund_failed'));

-- The shop: an unpaid checkout reminded once; a done order asked for a review.
ALTER TABLE shop_orders
  ADD COLUMN reminded_at     timestamptz NULL,
  ADD COLUMN review_asked_at timestamptz NULL;

CREATE TABLE shop_reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  order_id    uuid NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
  name        text NOT NULL,
  rating      smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  words       text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'shown', 'hidden')),
  reply       text NOT NULL DEFAULT '',
  decided_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  decided_at  timestamptz NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, item_id)
);
CREATE INDEX idx_shop_reviews_item ON shop_reviews (item_id, status, created_at DESC);

-- "Ask for a quote" on the shop: what the customer wants made, with photos.
CREATE TABLE shop_quote_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        integer NOT NULL UNIQUE,
  token         text NOT NULL UNIQUE,
  customer_id   uuid NOT NULL REFERENCES customers(id),
  name          text NOT NULL,
  phone         text NOT NULL,
  email         text NOT NULL DEFAULT '',
  item_id       uuid NULL REFERENCES catalog_items(id) ON DELETE SET NULL,
  what          text NOT NULL,
  size          text NOT NULL DEFAULT '',
  qty           integer NOT NULL DEFAULT 1 CHECK (qty BETWEEN 1 AND 9999),
  area          text NOT NULL DEFAULT '',
  budget        numeric(14,2) NULL,
  needed_by     date NULL,
  note          text NOT NULL DEFAULT '',
  photos        jsonb NOT NULL DEFAULT '[]',
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'quoted', 'closed')),
  quotation_id  uuid NULL REFERENCES quotations(id) ON DELETE SET NULL,
  handled_by    uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  ip            text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_shop_quote_requests_status ON shop_quote_requests (status, created_at DESC);
