-- The twelfth batch.
--
-- 1. Order limits for the restaurant websites (restaurantOnline): each
--    website order counts in the 15-minute slot it is due in (as soon as it
--    can be: when it will be ready; for later: the time chosen), with how
--    many dishes it has, so a slot holds no more than the restaurant set.
ALTER TABLE restaurant_online_orders ADD COLUMN slot_at timestamptz;
ALTER TABLE restaurant_online_orders ADD COLUMN dish_count integer NOT NULL DEFAULT 0;
CREATE INDEX idx_restaurant_online_orders_slot ON restaurant_online_orders(company_id, slot_at) WHERE slot_at IS NOT NULL;

-- 2. "Goes well with": the dishes suggested with a dish on the website, the
--    kiosk and the table's QR page, as staff picked them (none: the till's
--    own, from what is ordered together). A suggestion taken is marked on
--    its order line ({ suggested: true } in items), for the report.
ALTER TABLE restaurant_menu_items ADD COLUMN goes_with uuid[] NOT NULL DEFAULT '{}';

-- 3. Waste with a reason, and stock takes (restaurantWaste.service).
--    A dish thrown away that does not count its stock is costed from its
--    recipe, and its ingredients come off.
CREATE TABLE restaurant_waste (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_type     text NOT NULL CHECK (item_type IN ('menu', 'supply', 'ingredient')),
  item_id       uuid NOT NULL,
  variation_id  uuid,
  name          text NOT NULL,
  unit          text NOT NULL DEFAULT 'each',
  qty           numeric(12,2) NOT NULL CHECK (qty > 0),
  reason        text NOT NULL CHECK (reason IN ('dropped', 'expired', 'spoiled', 'made_wrong', 'sent_back', 'staff_meal', 'other')),
  cost          numeric(12,2) NOT NULL DEFAULT 0,
  note          text NOT NULL DEFAULT '',
  -- What came off the stock for it ([{ type, id, qty }]), put back if it is taken back.
  moves         jsonb NOT NULL DEFAULT '[]',
  created_by    uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  undone_at     timestamptz
);
CREATE INDEX idx_restaurant_waste_company ON restaurant_waste(company_id, created_at DESC);

CREATE TABLE restaurant_stock_takes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped')),
  -- [{ type, id, name, unit, expected, counted (null: not counted yet), unitCost }]
  lines         jsonb NOT NULL DEFAULT '[]',
  note          text NOT NULL DEFAULT '',
  started_by    uuid REFERENCES employees(id) ON DELETE SET NULL,
  finished_by   uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX idx_restaurant_stock_takes_company ON restaurant_stock_takes(company_id, created_at DESC);
CREATE UNIQUE INDEX idx_restaurant_stock_takes_open ON restaurant_stock_takes(company_id) WHERE status = 'open';

-- 4. Quotation options (Square's estimate packages): two or three options,
--    the customer picks one when approving online. options: [{ key, name,
--    note }]; each line belongs to one option (option_key) or to all ('').
--    Once chosen, the others' lines are kept in options[].dropped and taken
--    off the quotation, which is then the chosen option.
ALTER TABLE quotations ADD COLUMN options jsonb NOT NULL DEFAULT '[]';
ALTER TABLE quotations ADD COLUMN option_chosen text;
ALTER TABLE document_line_items ADD COLUMN option_key text NOT NULL DEFAULT '';

-- 5. Notes for the team on the till: a manager writes one, everyone sees it
--    when they sign in and taps "Got it"; who has read it is kept.
CREATE TABLE restaurant_team_notes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  body          text NOT NULL,
  tone          text NOT NULL DEFAULT 'info' CHECK (tone IN ('info', 'urgent', 'good')),
  until         timestamptz NOT NULL,
  pinned        boolean NOT NULL DEFAULT false,
  created_by    uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz
);
CREATE INDEX idx_restaurant_team_notes_company ON restaurant_team_notes(company_id, created_at DESC);
CREATE TABLE restaurant_team_note_reads (
  note_id       uuid NOT NULL REFERENCES restaurant_team_notes(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  read_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (note_id, employee_id)
);
