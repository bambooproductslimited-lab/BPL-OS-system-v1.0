-- Customers' own accounts on the ordering website
-- (restaurantCustomerAccounts.service.js): a name, a phone number (as
-- international digits, one account each) and a password, with where they
-- like their food brought. Signed in, an order is theirs (account_id) and
-- shows in their orders, on any phone. Ordering without an account stays.
CREATE TABLE restaurant_customer_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone          text NOT NULL UNIQUE,
  name           text NOT NULL,
  email          text NULL,
  password_hash  text NOT NULL,
  address        text NOT NULL DEFAULT '',
  landmark       text NOT NULL DEFAULT '',
  lat            numeric(9,6) NULL,
  lng            numeric(9,6) NULL,
  failed_logins  integer NOT NULL DEFAULT 0,
  locked_until   timestamptz NULL,
  last_login_at  timestamptz NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE restaurant_online_orders ADD COLUMN account_id uuid NULL REFERENCES restaurant_customer_accounts(id) ON DELETE SET NULL;
CREATE INDEX idx_restaurant_online_orders_account ON restaurant_online_orders (account_id, created_at DESC) WHERE account_id IS NOT NULL;
