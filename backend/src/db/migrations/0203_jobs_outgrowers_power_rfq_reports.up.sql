-- The twenty-first batch: production jobs from the bill of materials
-- (productionJobs.service.js), bamboo outgrowers (outgrowers.service.js),
-- the generator and power log (power.service.js), requests for quotes
-- (rfqs.service.js) and the monthly management report
-- (managementReport.service.js).

-- ── Production jobs ──
-- N of a product made from its bill of materials: the parts are taken out
-- of stock when the job starts (more taken, or some given back, while it
-- runs), the good ones go into stock when it finishes and what was spoilt
-- is recorded as scrap. The bill's cost is kept as it was when the job was
-- planned, to set the real cost against.
CREATE TABLE production_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          integer NOT NULL UNIQUE,
  product_id      uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty             numeric(12,2) NOT NULL CHECK (qty > 0),
  status          text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'done', 'cancelled')),
  due_on          date NULL,
  lead_id         uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  kiln_charge_id  uuid NULL REFERENCES kiln_charges(id) ON DELETE SET NULL,
  note            text NOT NULL DEFAULT '',
  plan_material   numeric(14,2) NOT NULL DEFAULT 0,
  plan_labour     numeric(14,2) NOT NULL DEFAULT 0,
  plan_overhead   numeric(14,2) NOT NULL DEFAULT 0,
  plan_hours      numeric(10,2) NOT NULL DEFAULT 0,
  labour_hours    numeric(10,2) NULL,
  labour_rate     numeric(10,2) NOT NULL DEFAULT 0,
  overhead        numeric(14,2) NULL,
  good_qty        numeric(12,2) NULL,
  scrap_qty       numeric(12,2) NOT NULL DEFAULT 0,
  scrap_reason    text NOT NULL DEFAULT '',
  created_by      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz NULL,
  started_by      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  finished_at     timestamptz NULL,
  finished_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  cancelled_at    timestamptz NULL,
  cancelled_by    uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  cancel_reason   text NOT NULL DEFAULT ''
);
CREATE INDEX idx_production_jobs_status ON production_jobs (status, due_on);
CREATE INDEX idx_production_jobs_product ON production_jobs (product_id);

CREATE TABLE production_job_parts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        uuid NOT NULL REFERENCES production_jobs(id) ON DELETE CASCADE,
  component_id  uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  planned_qty   numeric(14,4) NOT NULL DEFAULT 0,
  issued_qty    numeric(14,4) NOT NULL DEFAULT 0,
  unit_cost     numeric(12,4) NOT NULL DEFAULT 0,
  seq           integer NOT NULL DEFAULT 0,
  UNIQUE (job_id, component_id)
);

-- ── Bamboo outgrowers ──
-- Farmers who grow bamboo for us are suppliers already (migration 0067);
-- an outgrower is one with plots, harvests forecast, money advanced and paid
-- for each delivery, usually by Mobile Money.
ALTER TABLE suppliers
  ADD COLUMN outgrower     boolean NOT NULL DEFAULT false,
  ADD COLUMN momo_number   text NOT NULL DEFAULT '',
  ADD COLUMN momo_network  text NOT NULL DEFAULT '',
  ADD COLUMN joined_on     date NULL;

CREATE TABLE outgrower_plots (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id    uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  name           text NOT NULL,
  place          text NOT NULL DEFAULT '',
  lat            numeric(9,6) NULL,
  lng            numeric(9,6) NULL,
  hectares       numeric(8,2) NULL CHECK (hectares IS NULL OR hectares >= 0),
  species        text NOT NULL DEFAULT '',
  clumps         integer NULL CHECK (clumps IS NULL OR clumps >= 0),
  planted_year   integer NULL,
  cycle_months   integer NOT NULL DEFAULT 12 CHECK (cycle_months BETWEEN 1 AND 60),
  next_harvest   date NULL,
  expected_qty   numeric(12,2) NULL CHECK (expected_qty IS NULL OR expected_qty >= 0),
  unit           text NOT NULL DEFAULT 'poles',
  note           text NOT NULL DEFAULT '',
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_outgrower_plots ON outgrower_plots (supplier_id);

CREATE TABLE outgrower_advances (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id  uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  amount       numeric(12,2) NOT NULL CHECK (amount > 0),
  given_on     date NOT NULL DEFAULT current_date,
  method       text NOT NULL DEFAULT 'mobile_money' CHECK (method IN ('mobile_money', 'cash', 'bank')),
  reference    text NOT NULL DEFAULT '',
  note         text NOT NULL DEFAULT '',
  by_id        uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_outgrower_advances ON outgrower_advances (supplier_id, given_on);

-- One payment for one delivery (a raw batch): its value, what came off the
-- advances, and what was sent.
CREATE TABLE outgrower_payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id    uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  raw_batch_id   uuid NULL REFERENCES raw_batches(id) ON DELETE SET NULL,
  amount         numeric(12,2) NOT NULL CHECK (amount >= 0),
  advance_taken  numeric(12,2) NOT NULL DEFAULT 0 CHECK (advance_taken >= 0),
  paid           numeric(12,2) NOT NULL CHECK (paid >= 0),
  method         text NOT NULL DEFAULT 'mobile_money' CHECK (method IN ('mobile_money', 'cash', 'bank')),
  momo_number    text NOT NULL DEFAULT '',
  reference      text NOT NULL DEFAULT '',
  paid_on        date NOT NULL DEFAULT current_date,
  note           text NOT NULL DEFAULT '',
  texted         boolean NOT NULL DEFAULT false,
  by_id          uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (advance_taken + paid = amount)
);
CREATE INDEX idx_outgrower_payments ON outgrower_payments (supplier_id, paid_on);
CREATE UNIQUE INDEX uq_outgrower_payment_batch ON outgrower_payments (raw_batch_id) WHERE raw_batch_id IS NOT NULL;

-- ── Generators and power ──
-- Per company (the factory, each restaurant): its generators and prepaid
-- meters, the power cuts, the hours each generator ran, the fuel bought for
-- it and the prepaid top-ups.
CREATE TABLE power_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('generator', 'meter')),
  name          text NOT NULL,
  kva           numeric(8,1) NULL,
  fuel          text NOT NULL DEFAULT 'diesel' CHECK (fuel IN ('diesel', 'petrol', 'gas')),
  tank_litres   numeric(8,1) NULL,
  expected_lph  numeric(6,2) NULL CHECK (expected_lph IS NULL OR expected_lph > 0),
  meter_no      text NOT NULL DEFAULT '',
  hour_meter    numeric(10,1) NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_power_sources ON power_sources (company_id);

CREATE TABLE power_outages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz NULL,
  note        text NOT NULL DEFAULT '',
  by_id       uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX uq_power_outage_open ON power_outages (company_id) WHERE ended_at IS NULL;
CREATE INDEX idx_power_outages ON power_outages (company_id, started_at);

CREATE TABLE power_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id   uuid NOT NULL REFERENCES power_sources(id) ON DELETE CASCADE,
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz NULL,
  hours       numeric(8,2) NULL CHECK (hours IS NULL OR hours >= 0),
  meter_end   numeric(10,1) NULL,
  note        text NOT NULL DEFAULT '',
  by_id       uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_power_run_open ON power_runs (source_id) WHERE ended_at IS NULL;
CREATE INDEX idx_power_runs ON power_runs (source_id, started_at);

CREATE TABLE power_fuel (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id   uuid NOT NULL REFERENCES power_sources(id) ON DELETE CASCADE,
  on_day      date NOT NULL DEFAULT current_date,
  litres      numeric(8,1) NOT NULL CHECK (litres > 0),
  cost        numeric(12,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  vendor      text NOT NULL DEFAULT '',
  note        text NOT NULL DEFAULT '',
  by_id       uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_power_fuel ON power_fuel (source_id, on_day);

CREATE TABLE power_topups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id   uuid NOT NULL REFERENCES power_sources(id) ON DELETE CASCADE,
  on_day      date NOT NULL DEFAULT current_date,
  amount      numeric(12,2) NOT NULL CHECK (amount > 0),
  units       numeric(10,1) NULL CHECK (units IS NULL OR units >= 0),
  reference   text NOT NULL DEFAULT '',
  note        text NOT NULL DEFAULT '',
  by_id       uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_power_topups ON power_topups (source_id, on_day);

-- ── Requests for quotes ──
-- One request to several suppliers (Bamboo Products' suppliers, or a
-- restaurant's): their prices side by side with how each has done, and the
-- winner's becomes the order — the purchase request ordered at Bamboo
-- Products, a draft purchase order at a restaurant.
CREATE TABLE rfqs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number         integer NOT NULL UNIQUE,
  kind           text NOT NULL CHECK (kind IN ('bpl', 'restaurant')),
  company_id     uuid NULL REFERENCES companies(id) ON DELETE CASCADE,
  title          text NOT NULL,
  request_id     uuid NULL REFERENCES procurement_requests(id) ON DELETE SET NULL,
  needed_by      date NULL,
  reply_by       date NULL,
  note           text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'awarded', 'cancelled')),
  awarded_to     uuid NULL,
  awarded_at     timestamptz NULL,
  awarded_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  award_note     text NOT NULL DEFAULT '',
  po_id          uuid NULL REFERENCES restaurant_purchase_orders(id) ON DELETE SET NULL,
  created_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'bpl' OR company_id IS NOT NULL)
);
CREATE INDEX idx_rfqs_status ON rfqs (status, created_at);

CREATE TABLE rfq_lines (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id     uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  name       text NOT NULL,
  qty        numeric(12,3) NOT NULL CHECK (qty > 0),
  unit       text NOT NULL DEFAULT '',
  item_type  text NULL CHECK (item_type IS NULL OR item_type IN ('menu', 'ingredient', 'supply')),
  item_id    uuid NULL,
  seq        integer NOT NULL DEFAULT 0
);
CREATE INDEX idx_rfq_lines ON rfq_lines (rfq_id, seq);

-- Each supplier asked: when, and their quote once it is in.
CREATE TABLE rfq_suppliers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id         uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  supplier_id    uuid NOT NULL,
  name           text NOT NULL,
  phone          text NOT NULL DEFAULT '',
  email          text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'asked' CHECK (status IN ('asked', 'quoted', 'declined')),
  sent_at        timestamptz NULL,
  quoted_at      timestamptz NULL,
  delivery_days  integer NULL CHECK (delivery_days IS NULL OR delivery_days >= 0),
  valid_until    date NULL,
  terms          text NOT NULL DEFAULT '',
  note           text NOT NULL DEFAULT '',
  file           jsonb NULL,
  total          numeric(14,2) NULL,
  UNIQUE (rfq_id, supplier_id)
);

CREATE TABLE rfq_prices (
  rfq_supplier_id  uuid NOT NULL REFERENCES rfq_suppliers(id) ON DELETE CASCADE,
  line_id          uuid NOT NULL REFERENCES rfq_lines(id) ON DELETE CASCADE,
  unit_price       numeric(12,4) NOT NULL CHECK (unit_price >= 0),
  PRIMARY KEY (rfq_supplier_id, line_id)
);

-- ── The monthly management report ──
-- Who it is emailed to, and whether it goes on its own on the 1st.
ALTER TABLE settings ADD COLUMN management_report jsonb NOT NULL DEFAULT '{}';
CREATE TABLE management_reports (
  month      text PRIMARY KEY,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  sent_to    text NOT NULL DEFAULT '',
  sent_by    uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  auto       boolean NOT NULL DEFAULT false
);

-- Permissions (db/referenceData.js gives them to the roles). Production jobs
-- use production.read / production.manage; outgrowers supplier.read,
-- supplier.manage and, to pay, procurement.approve or bill.manage; quotes
-- procurement.approve / supplier.manage (Bamboo Products) and
-- restaurant.manage; the monthly report report.read.
INSERT INTO permissions (key, "group", label) VALUES
  ('power.manage', 'Operations', 'Keep the generator and power log')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r JOIN (VALUES
  ('administrator', 'power.manage'),
  ('general_manager', 'power.manage'),
  ('department_manager', 'power.manage')
) AS p(role, key) ON p.role = r.key
ON CONFLICT DO NOTHING;
