-- The twentieth batch: licences and permits (licences.service.js), the kiln
-- and treatment log (kilns.service.js), bills of materials and product
-- costing (bom.service.js), supplier scorecards (scorecards.service.js),
-- policies to read and sign (policies.service.js).

-- ── Licences and permits ──
-- What the companies and their sites must hold to trade: operating permits,
-- the fire certificate, food hygiene, EPA, the liquor licence, signage. The
-- row is the period in force; renewing moves the old period to the history.
-- Staff certificates (training) and vehicle papers (vehicles) stay where
-- they are and are shown alongside.
CREATE TABLE licences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NULL REFERENCES companies(id) ON DELETE SET NULL,
  kind            text NOT NULL DEFAULT 'other' CHECK (kind IN ('business', 'fire', 'food', 'environment', 'building', 'liquor', 'signage', 'export', 'insurance', 'other')),
  title           text NOT NULL,
  authority       text NOT NULL DEFAULT '',
  number          text NOT NULL DEFAULT '',
  site            text NOT NULL DEFAULT '',
  issued_on       date NULL,
  expires_on      date NULL,
  cost            numeric(14,2) NOT NULL DEFAULT 0,
  owner_id        uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  lead_days       integer NOT NULL DEFAULT 30 CHECK (lead_days BETWEEN 0 AND 365),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'renewing', 'closed')),
  renewing_since  date NULL,
  note            text NOT NULL DEFAULT '',
  files           jsonb NOT NULL DEFAULT '[]',
  created_by      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_licences_expires ON licences (expires_on) WHERE status <> 'closed';

-- The periods before the one in force.
CREATE TABLE licence_renewals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licence_id  uuid NOT NULL REFERENCES licences(id) ON DELETE CASCADE,
  number      text NOT NULL DEFAULT '',
  issued_on   date NULL,
  expires_on  date NULL,
  cost        numeric(14,2) NOT NULL DEFAULT 0,
  files       jsonb NOT NULL DEFAULT '[]',
  note        text NOT NULL DEFAULT '',
  by_id       uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_licence_renewals ON licence_renewals (licence_id, expires_on);

-- ── Kilns and treatment ──
-- A kiln, a treatment tank (the borate soak) or an air-drying shed; each
-- takes one charge (a load) at a time, read for moisture until it is dry.
CREATE TABLE kilns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  kind             text NOT NULL DEFAULT 'kiln' CHECK (kind IN ('kiln', 'tank', 'shed')),
  capacity         numeric(12,2) NOT NULL DEFAULT 0,
  unit             text NOT NULL DEFAULT 'pieces',
  target_moisture  numeric(5,1) NULL,
  days             numeric(5,1) NULL,
  active           boolean NOT NULL DEFAULT true,
  seq              integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE kiln_charges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number           integer NOT NULL UNIQUE,
  kiln_id          uuid NOT NULL REFERENCES kilns(id) ON DELETE CASCADE,
  raw_batch_id     uuid NULL REFERENCES raw_batches(id) ON DELETE SET NULL,
  product_id       uuid NULL REFERENCES products(id) ON DELETE SET NULL,
  description      text NOT NULL DEFAULT '',
  qty              numeric(12,2) NOT NULL DEFAULT 0,
  unit             text NOT NULL DEFAULT 'pieces',
  solution         text NOT NULL DEFAULT '',
  planned_days     numeric(5,1) NULL,
  target_moisture  numeric(5,1) NULL,
  start_moisture   numeric(5,1) NULL,
  status           text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'aborted')),
  started_at       timestamptz NOT NULL DEFAULT now(),
  started_by       uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  ended_at         timestamptz NULL,
  ended_by         uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  end_moisture     numeric(5,1) NULL,
  out_qty          numeric(12,2) NULL,
  reject_qty       numeric(12,2) NOT NULL DEFAULT 0,
  note             text NOT NULL DEFAULT '',
  end_note         text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX uq_kiln_running ON kiln_charges (kiln_id) WHERE status = 'running';
CREATE INDEX idx_kiln_charges_started ON kiln_charges (started_at);

CREATE TABLE kiln_readings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_id    uuid NOT NULL REFERENCES kiln_charges(id) ON DELETE CASCADE,
  at           timestamptz NOT NULL DEFAULT now(),
  moisture     numeric(5,1) NULL,
  temperature  numeric(5,1) NULL,
  humidity     numeric(5,1) NULL,
  note         text NOT NULL DEFAULT '',
  by_id        uuid NULL REFERENCES employees(id) ON DELETE SET NULL
);
CREATE INDEX idx_kiln_readings ON kiln_readings (charge_id, at);

-- ── Bills of materials ──
-- What one of a product is made of: other products (culms, glue, lacquer,
-- screws) with a share for waste; labour and overheads alongside.
CREATE TABLE bom_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  component_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty           numeric(14,4) NOT NULL CHECK (qty > 0),
  waste_pct     numeric(5,2) NOT NULL DEFAULT 0 CHECK (waste_pct >= 0 AND waste_pct <= 90),
  note          text NOT NULL DEFAULT '',
  seq           integer NOT NULL DEFAULT 0,
  UNIQUE (product_id, component_id),
  CHECK (product_id <> component_id)
);
CREATE INDEX idx_bom_lines_component ON bom_lines (component_id);

CREATE TABLE bom_costs (
  product_id    uuid PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  labour_hours  numeric(8,2) NOT NULL DEFAULT 0 CHECK (labour_hours >= 0),
  labour_rate   numeric(10,2) NOT NULL DEFAULT 0 CHECK (labour_rate >= 0),
  overhead      numeric(12,2) NOT NULL DEFAULT 0 CHECK (overhead >= 0),
  note          text NOT NULL DEFAULT '',
  updated_by    uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Each time the cost price on file was set from the bill of materials.
CREATE TABLE product_cost_history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  cost_before  numeric(12,2) NOT NULL,
  cost_after   numeric(12,2) NOT NULL,
  source       text NOT NULL DEFAULT 'bom',
  by_id        uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_product_cost_history ON product_cost_history (product_id, at);

-- ── Supplier scorecards ──
-- A delivery rated by whoever took it in; the rest of the score comes from
-- the purchase orders (restaurants) and raw bamboo intake (Bamboo Products).
-- kind 'bpl' → suppliers, kind 'restaurant' → restaurant_suppliers.
CREATE TABLE supplier_ratings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('bpl', 'restaurant')),
  supplier_id   uuid NOT NULL,
  company_id    uuid NULL REFERENCES companies(id) ON DELETE CASCADE,
  ref           text NOT NULL DEFAULT '',
  delivered_on  date NOT NULL DEFAULT current_date,
  on_time       boolean NULL,
  complete      boolean NULL,
  quality       smallint NULL CHECK (quality BETWEEN 1 AND 5),
  service       smallint NULL CHECK (service BETWEEN 1 AND 5),
  price         smallint NULL CHECK (price BETWEEN 1 AND 5),
  note          text NOT NULL DEFAULT '',
  by_id         uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_supplier_ratings ON supplier_ratings (kind, supplier_id, delivered_on);

-- ── Policies to read and sign ──
-- The handbook, the code of conduct, the safety rules: each published to
-- everyone, a company or a department; staff read and sign in My space. A
-- new version asks everyone again. Joiners get them on their checklist.
CREATE TABLE policies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title          text NOT NULL,
  category       text NOT NULL DEFAULT 'other' CHECK (category IN ('handbook', 'conduct', 'safety', 'it', 'hr', 'food', 'finance', 'other')),
  summary        text NOT NULL DEFAULT '',
  body           text NOT NULL DEFAULT '',
  file           jsonb NULL,
  version        integer NOT NULL DEFAULT 1,
  version_note   text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  published_at   timestamptz NULL,
  company_id     uuid NULL REFERENCES companies(id) ON DELETE SET NULL,
  department_id  uuid NULL REFERENCES departments(id) ON DELETE SET NULL,
  must_sign      boolean NOT NULL DEFAULT true,
  sign_days      integer NOT NULL DEFAULT 14 CHECK (sign_days BETWEEN 1 AND 90),
  joiners        boolean NOT NULL DEFAULT true,
  created_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- What each published version said.
CREATE TABLE policy_versions (
  policy_id     uuid NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  version       integer NOT NULL,
  title         text NOT NULL,
  body          text NOT NULL DEFAULT '',
  file          jsonb NULL,
  note          text NOT NULL DEFAULT '',
  published_at  timestamptz NOT NULL DEFAULT now(),
  by_id         uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  PRIMARY KEY (policy_id, version)
);

CREATE TABLE policy_signatures (
  policy_id    uuid NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  version      integer NOT NULL,
  signed_name  text NOT NULL,
  signed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (policy_id, employee_id, version)
);
CREATE INDEX idx_policy_signatures_employee ON policy_signatures (employee_id);

-- A joiner's "Read and sign" step ticks itself when they sign.
ALTER TABLE onboard_steps DROP CONSTRAINT onboard_steps_kind_check;
ALTER TABLE onboard_steps ADD CONSTRAINT onboard_steps_kind_check CHECK (kind IN ('task', 'device', 'tool', 'asset', 'ppe', 'policy', 'final_pay', 'exit_interview', 'mark_left'));

-- Permissions (db/referenceData.js gives them to the roles). The kiln log
-- and bills of materials use production.read / production.manage; supplier
-- scorecards use supplier.read, supplier.manage, procurement.approve and the
-- restaurant permissions.
INSERT INTO permissions (key, "group", label) VALUES
  ('licence.manage', 'Operations', 'Keep the licences and permits, and renew them'),
  ('policy.manage', 'People', 'Publish policies for staff to read and sign')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r JOIN (VALUES
  ('administrator', 'licence.manage'), ('administrator', 'policy.manage'),
  ('general_manager', 'licence.manage'), ('general_manager', 'policy.manage'),
  ('executive', 'licence.manage'),
  ('finance_manager', 'licence.manage'),
  ('finance_hr_manager', 'licence.manage'), ('finance_hr_manager', 'policy.manage'),
  ('hr_manager', 'policy.manage')
) AS p(role, key) ON p.role = r.key
ON CONFLICT DO NOTHING;
