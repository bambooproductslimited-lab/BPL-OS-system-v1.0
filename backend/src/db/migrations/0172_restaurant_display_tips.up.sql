-- The screen that faces the customer (restaurantDisplays.service.js): a
-- tablet or a second monitor that shows the order as it is rung up, the
-- total, a tip to choose and a thank-you. It says hello with a key of its
-- own and a code for the till to pair it (pair_code); paired, it shows what
-- that till (till_device) sends it (state) and keeps the customer's tip
-- choice for the till to read (tip).
CREATE TABLE restaurant_displays (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NULL REFERENCES companies(id) ON DELETE CASCADE,
  key_hash      text NOT NULL UNIQUE,
  pair_code     text NULL,
  code_expires  timestamptz NULL,
  till_device   text NULL,
  name          text NOT NULL DEFAULT '',
  state         jsonb NOT NULL DEFAULT '{}',
  state_at      timestamptz NULL,
  tip           jsonb NULL,
  paired_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  paired_at     timestamptz NULL,
  last_seen_at  timestamptz NULL,
  ip            text NOT NULL DEFAULT '',
  user_agent    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_restaurant_displays_code ON restaurant_displays (pair_code) WHERE pair_code IS NOT NULL;
CREATE INDEX idx_restaurant_displays_till ON restaurant_displays (company_id, till_device) WHERE company_id IS NOT NULL;

-- Tips: given on top of the bill (the payments add up to total + tip), not
-- a sale; reported apart, by who served.
ALTER TABLE restaurant_orders ADD COLUMN tip numeric(12,2) NOT NULL DEFAULT 0 CHECK (tip >= 0);

-- "Your food is ready": a pickup customer texted once, when the kitchen has
-- all of their order ready ({ channel, to, at, status }).
ALTER TABLE restaurant_kitchen_tickets ADD COLUMN ready_text jsonb NULL;
