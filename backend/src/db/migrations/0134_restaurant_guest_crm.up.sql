-- A guest CRM for each restaurant (services/restaurantCrm.service.js),
-- starting with Bamboo Garden: guests' profiles (restaurant_guests,
-- migration 0049) filled from Square's customers and from the orders
-- customer service takes by phone, WhatsApp or Bolt (until now kept in a
-- spreadsheet), with what each guest said about the food and whether
-- someone called them back. Those orders are rung up on Square too, so each
-- is linked to its sale (restaurant_orders) and counted once.

-- A phone number in one form (233XXXXXXXXX for a Ghanaian number however
-- it was typed: 024 123 4567, +233 24 123 4567, 241234567), so the same
-- guest is found again by number.
CREATE FUNCTION restaurant_phone_key(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN d = '' THEN ''
    WHEN d LIKE '00%' THEN substr(d, 3)
    WHEN length(d) = 10 AND left(d, 1) = '0' THEN '233' || substr(d, 2)
    WHEN length(d) = 9 THEN '233' || d
    ELSE d END
  FROM (SELECT regexp_replace(coalesce(p, ''), '\D', '', 'g') AS d) x
$$;

-- A name without the "Madam", "Mr" or "Auntie" staff put in front of it,
-- lower case, so "Madam Linda" and "linda" are seen as the same name.
CREATE FUNCTION restaurant_name_key(n text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(regexp_replace(
    regexp_replace(lower(coalesce(n, '')), '^\s*((madam|madame|mrs|mr|ms|miss|dr|auntie|aunty|uncle|sister|sis|brother|bro|chef|boss)\.?\s+)+', ''),
    '[^a-z0-9]+', ' ', 'g'))
$$;

ALTER TABLE restaurant_guests ADD COLUMN phone_key text NOT NULL DEFAULT '';
ALTER TABLE restaurant_guests ADD COLUMN name_key text NOT NULL DEFAULT '';
ALTER TABLE restaurant_guests ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'till', 'order', 'import', 'square'));
-- The Square customer this guest is (restaurantSquareImport.service.js).
ALTER TABLE restaurant_guests ADD COLUMN square_customer_id text NULL;
CREATE UNIQUE INDEX uq_restaurant_guests_square ON restaurant_guests(company_id, square_customer_id) WHERE square_customer_id IS NOT NULL;

-- What Square says about a sale beyond its items and total: where it came
-- from (Square's own till, or an app such as Bolt Food), pick-up or
-- delivery, and who it was for — the customer on the order, or the name and
-- number on its pick-up or delivery.
ALTER TABLE restaurant_orders ADD COLUMN source_name text NOT NULL DEFAULT '';
ALTER TABLE restaurant_orders ADD COLUMN fulfillment text NOT NULL DEFAULT '';
ALTER TABLE restaurant_orders ADD COLUMN customer_name text NOT NULL DEFAULT '';
ALTER TABLE restaurant_orders ADD COLUMN customer_phone text NOT NULL DEFAULT '';
ALTER TABLE restaurant_orders ADD COLUMN square_customer_id text NULL;
ALTER TABLE restaurant_orders ADD COLUMN ticket_name text NOT NULL DEFAULT '';

CREATE FUNCTION restaurant_guests_keys() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.phone_key := restaurant_phone_key(NEW.phone);
  NEW.name_key := restaurant_name_key(NEW.name);
  RETURN NEW;
END $$;
CREATE TRIGGER restaurant_guests_keys BEFORE INSERT OR UPDATE OF name, phone ON restaurant_guests
  FOR EACH ROW EXECUTE FUNCTION restaurant_guests_keys();
UPDATE restaurant_guests SET phone = phone;
CREATE INDEX idx_restaurant_guests_phone_key ON restaurant_guests(company_id, phone_key) WHERE phone_key <> '';
CREATE INDEX idx_restaurant_guests_name_key ON restaurant_guests(company_id, name_key);

-- One order taken outside the till: when, how it came in (channel), how it
-- was served, what was ordered (as the guest said it, or menu codes), and
-- the guest's feedback with an optional 1–5 rating. A complaint opens a
-- follow-up (someone should call back) until it is marked done.
CREATE TABLE restaurant_guest_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  guest_id        uuid NULL REFERENCES restaurant_guests(id) ON DELETE SET NULL,
  ordered_on      date NOT NULL,
  channel         text NOT NULL DEFAULT 'phone' CHECK (channel IN ('phone', 'whatsapp', 'bolt', 'walk_in', 'instagram', 'facebook', 'website', 'other')),
  service         text NOT NULL DEFAULT 'pickup' CHECK (service IN ('pickup', 'dine_in', 'delivery', 'reservation')),
  items           text NOT NULL DEFAULT '',
  amount          numeric NULL CHECK (amount IS NULL OR amount >= 0),
  party_size      int NULL CHECK (party_size IS NULL OR party_size BETWEEN 1 AND 500),
  table_note      text NOT NULL DEFAULT '',
  feedback        text NOT NULL DEFAULT '',
  rating          int NULL CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  follow_up       text NOT NULL DEFAULT 'none' CHECK (follow_up IN ('none', 'open', 'done')),
  follow_up_note  text NOT NULL DEFAULT '',
  followed_up_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  followed_up_at  timestamptz NULL,
  -- The sale on the till (Square) this order was rung up as: found by the
  -- OS ('auto': same day, same dishes, and Bolt or pick-up/delivery and the
  -- name agreeing when Square has them), chosen by staff ('staff'), or
  -- 'none' when staff said there is no sale to link.
  till_order_id   uuid NULL UNIQUE REFERENCES restaurant_orders(id) ON DELETE SET NULL,
  till_link       text NOT NULL DEFAULT '' CHECK (till_link IN ('', 'auto', 'staff', 'none')),
  external_key    text NULL,
  created_by      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, external_key)
);
CREATE INDEX idx_restaurant_guest_orders_company ON restaurant_guest_orders(company_id, ordered_on);
CREATE INDEX idx_restaurant_guest_orders_guest ON restaurant_guest_orders(guest_id);
CREATE INDEX idx_restaurant_guest_orders_open ON restaurant_guest_orders(company_id) WHERE follow_up = 'open';
