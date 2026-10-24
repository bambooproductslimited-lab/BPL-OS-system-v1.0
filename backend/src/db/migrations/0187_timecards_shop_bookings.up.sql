-- Breaks within a shift clocked on the till (restaurantTimecards.service.js):
-- the shift itself is an attendance row, as the kiosk's are.
CREATE TABLE attendance_breaks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attendance_id  uuid NOT NULL REFERENCES attendance(id) ON DELETE CASCADE,
  starts_at      timestamptz NOT NULL DEFAULT now(),
  ends_at        timestamptz NULL,
  paid           boolean NOT NULL DEFAULT false,
  CHECK (ends_at IS NULL OR ends_at >= starts_at)
);
CREATE INDEX idx_attendance_breaks_shift ON attendance_breaks (attendance_id);
CREATE UNIQUE INDEX ux_attendance_breaks_open ON attendance_breaks (attendance_id) WHERE ends_at IS NULL;

-- A shift on the rota offered to someone else (restaurantRota.service.js):
-- taken by a colleague, then approved (the shift becomes theirs) or not.
CREATE TABLE restaurant_shift_swaps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shift_id    uuid NOT NULL REFERENCES restaurant_rota_shifts(id) ON DELETE CASCADE,
  offered_by  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  taken_by    uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  note        text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'taken', 'approved', 'declined', 'cancelled')),
  decided_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  decided_at  timestamptz NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_shift_swaps_company ON restaurant_shift_swaps (company_id, status);
CREATE UNIQUE INDEX ux_shift_swaps_live ON restaurant_shift_swaps (shift_id) WHERE status IN ('open', 'taken');

-- Gift cards bought on the restaurant's website (restaurantGiftCards.service.js),
-- paid through Paystack before the card is made.
ALTER TABLE restaurant_gift_cards DROP CONSTRAINT restaurant_gift_cards_sold_method_check;
ALTER TABLE restaurant_gift_cards ADD CONSTRAINT restaurant_gift_cards_sold_method_check CHECK (sold_method IN ('cash', 'mobile_money', 'online'));
ALTER TABLE restaurant_gift_cards ADD COLUMN to_email text NOT NULL DEFAULT '';
ALTER TABLE restaurant_gift_cards ADD COLUMN buyer_phone text NOT NULL DEFAULT '';
ALTER TABLE restaurant_gift_cards ADD COLUMN buyer_email text NOT NULL DEFAULT '';
ALTER TABLE restaurant_paystack_payments DROP CONSTRAINT restaurant_paystack_payments_purpose_check;
ALTER TABLE restaurant_paystack_payments ADD CONSTRAINT restaurant_paystack_payments_purpose_check CHECK (purpose IN ('till', 'kiosk', 'table', 'gift'));
ALTER TABLE restaurant_paystack_payments ADD COLUMN meta jsonb NOT NULL DEFAULT '{}';
ALTER TABLE restaurant_paystack_payments ADD COLUMN gift_card_id uuid NULL REFERENCES restaurant_gift_cards(id) ON DELETE SET NULL;

-- Bamboo Products' online shop (shop.service.js): orders from the website,
-- each billed as an invoice and paid online through it.
ALTER TABLE settings ADD COLUMN shop jsonb NOT NULL DEFAULT '{}';
CREATE TABLE shop_orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no     text NOT NULL UNIQUE,
  customer_id  uuid NOT NULL REFERENCES customers(id),
  invoice_id   uuid NULL REFERENCES invoices(id) ON DELETE SET NULL,
  share_id     uuid NULL REFERENCES document_shares(id) ON DELETE SET NULL,
  name         text NOT NULL,
  phone        text NOT NULL DEFAULT '',
  email        text NOT NULL DEFAULT '',
  fulfilment   text NOT NULL CHECK (fulfilment IN ('delivery', 'pickup')),
  address      text NOT NULL DEFAULT '',
  note         text NOT NULL DEFAULT '',
  lines        jsonb NOT NULL DEFAULT '[]',
  total        numeric(14,2) NOT NULL,
  status       text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'ready', 'done', 'cancelled')),
  ip           text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_shop_orders_created ON shop_orders (created_at DESC);

-- Booking a consultation on the website (bookings.service.js): a showroom
-- visit, a site measurement…, on a time the business is open and free.
ALTER TABLE settings ADD COLUMN booking jsonb NOT NULL DEFAULT '{}';
CREATE TABLE appointments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service        text NOT NULL,
  service_name   text NOT NULL DEFAULT '',
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  name           text NOT NULL,
  phone          text NOT NULL DEFAULT '',
  email          text NOT NULL DEFAULT '',
  location       text NOT NULL DEFAULT '',
  note           text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'confirmed', 'cancelled', 'done')),
  lead_id        uuid NULL REFERENCES crm_leads(id) ON DELETE SET NULL,
  site_visit_id  uuid NULL REFERENCES crm_site_visits(id) ON DELETE SET NULL,
  assigned_to    uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  token          text NOT NULL UNIQUE,
  ip             text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  cancelled_at   timestamptz NULL,
  CHECK (ends_at > starts_at)
);
CREATE INDEX idx_appointments_when ON appointments (starts_at);

-- A quotation approved on its link, invoiced at once for its deposit
-- (documentAnswers.service.js): the invoice's link, to pay it.
ALTER TABLE quotations ADD COLUMN pay_share_id uuid NULL REFERENCES document_shares(id) ON DELETE SET NULL;
