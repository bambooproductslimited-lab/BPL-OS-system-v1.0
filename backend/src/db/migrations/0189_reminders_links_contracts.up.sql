-- Reminders the day before (jobs/reminders.js): a BPL appointment's and a
-- restaurant table booking's, sent once.
ALTER TABLE appointments ADD COLUMN reminded_at timestamptz NULL;
ALTER TABLE restaurant_bookings ADD COLUMN reminded_at timestamptz NULL;

-- Payment links (paymentLinks.service.js): an amount, or items from the
-- catalogue, to pay on Bamboo Products' customer website; each payment is an
-- invoice raised for whoever pays and paid on its page.
CREATE TABLE payment_links (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token        text NOT NULL UNIQUE,
  title        text NOT NULL,
  description  text NOT NULL DEFAULT '',
  amount       numeric(14,2) NULL,              -- a fixed amount, or…
  lines        jsonb NOT NULL DEFAULT '[]',     -- …items from the catalogue
  customer_id  uuid NULL REFERENCES customers(id) ON DELETE SET NULL,
  single_use   boolean NOT NULL DEFAULT false,
  expires_on   date NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'closed')),
  created_by   uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (amount IS NULL OR amount > 0)
);
CREATE INDEX idx_payment_links_created ON payment_links (created_at DESC);
ALTER TABLE invoices ADD COLUMN payment_link_id uuid NULL REFERENCES payment_links(id) ON DELETE SET NULL;
CREATE INDEX idx_invoices_payment_link ON invoices (payment_link_id) WHERE payment_link_id IS NOT NULL;

-- Contracts signed online (contracts.service.js): written from a template
-- with the customer's details filled in, sent on a link, signed with a
-- name and a drawn signature (or declined), kept as signed.
CREATE TABLE contract_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  body        text NOT NULL,
  created_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE contract_no_seq;
CREATE TABLE contracts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_no   text NOT NULL UNIQUE DEFAULT ('CT-' || lpad(nextval('contract_no_seq')::text, 4, '0')),
  customer_id   uuid NOT NULL REFERENCES customers(id),
  quotation_id  uuid NULL REFERENCES quotations(id) ON DELETE SET NULL,
  title         text NOT NULL,
  body          text NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'signed', 'declined', 'void')),
  token         text NOT NULL UNIQUE,
  sent_at       timestamptz NULL,
  viewed_at     timestamptz NULL,
  signer_name   text NOT NULL DEFAULT '',
  signature     jsonb NULL,
  signed_at     timestamptz NULL,
  signed_ip     text NOT NULL DEFAULT '',
  signed_ua     text NOT NULL DEFAULT '',
  decline_note  text NOT NULL DEFAULT '',
  counter_name  text NOT NULL DEFAULT '',      -- who signs for Bamboo Products
  created_by    uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_contracts_customer ON contracts (customer_id);

-- Discount codes on the online shop (settings.shop.codes): the code an
-- order used and what it took off.
ALTER TABLE shop_orders ADD COLUMN promo_code text NOT NULL DEFAULT '';
ALTER TABLE shop_orders ADD COLUMN discount numeric(14,2) NOT NULL DEFAULT 0;

-- Busy on a restaurant's website (restaurantDelivery busy): more minutes on
-- every order, or new orders paused, until a time.
ALTER TABLE restaurant_delivery_settings ADD COLUMN busy jsonb NOT NULL DEFAULT '{}';
