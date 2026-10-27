-- The sixteenth batch.
--
-- 1. Customer statements and credit limits. A customer can be given a
-- credit limit (an invoice that would take what they owe over it needs a
-- second "yes"), and a statement of their account — invoices, payments,
-- credit notes, the running balance, how old what they owe is — sent by a
-- link of its own, or every month by itself.
ALTER TABLE customers ADD COLUMN credit_limit numeric(14,2) NULL CHECK (credit_limit IS NULL OR credit_limit >= 0);
ALTER TABLE customers ADD COLUMN statement_monthly boolean NOT NULL DEFAULT false;

CREATE TABLE statement_links (
  token       text PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  currency    text NOT NULL DEFAULT 'GHS',
  from_date   date NULL,
  expires_at  timestamptz NOT NULL,
  created_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  viewed_at   timestamptz NULL
);
CREATE INDEX idx_statement_links_customer ON statement_links (customer_id, created_at DESC);

CREATE TABLE statement_sends (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('email', 'whatsapp', 'link')),
  to_address  text NOT NULL DEFAULT '',
  period      text NULL,
  automatic   boolean NOT NULL DEFAULT false,
  balance     numeric(14,2) NOT NULL DEFAULT 0,
  sent_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  sent_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_statement_sends_customer ON statement_sends (customer_id, sent_at DESC);
-- One automatic statement a customer a month.
CREATE UNIQUE INDEX uq_statement_sends_monthly ON statement_sends (customer_id, period) WHERE automatic;

-- 2. Cash flow forecast: what each company has in the bank and in hand
-- today (settings.cashflow), and money expected in or out that the OS does
-- not know of by itself (a loan repayment, rent received, tax).
ALTER TABLE settings ADD COLUMN cashflow jsonb NOT NULL DEFAULT '{}';

CREATE TABLE cashflow_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  direction   text NOT NULL CHECK (direction IN ('in', 'out')),
  label       text NOT NULL,
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  starts_on   date NOT NULL,
  repeat      text NOT NULL DEFAULT 'once' CHECK (repeat IN ('once', 'weekly', 'monthly')),
  ends_on     date NULL,
  created_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cashflow_items_company ON cashflow_items (company_id);

-- 3. Salary advances: asked for by the person, approved and paid out by
-- Finance, repaid by instalments taken off their payslips.
CREATE TABLE salary_advances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          integer NOT NULL UNIQUE,
  employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  amount          numeric(12,2) NOT NULL CHECK (amount > 0),
  months          integer NOT NULL DEFAULT 1 CHECK (months BETWEEN 1 AND 12),
  instalment      numeric(12,2) NOT NULL CHECK (instalment > 0),
  reason          text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'declined', 'paid', 'repaid', 'cancelled')),
  repaid          numeric(12,2) NOT NULL DEFAULT 0 CHECK (repaid >= 0),
  decided_by      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  decided_at      timestamptz NULL,
  decline_reason  text NOT NULL DEFAULT '',
  paid_at         date NULL,
  paid_method     text NULL CHECK (paid_method IS NULL OR paid_method IN ('bank', 'mobile_money', 'cash')),
  paid_reference  text NOT NULL DEFAULT '',
  paid_by         uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_by      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_salary_advances_employee ON salary_advances (employee_id, created_at DESC);
CREATE INDEX idx_salary_advances_open ON salary_advances (status) WHERE status IN ('requested', 'approved', 'paid');

CREATE TABLE salary_advance_repayments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id  uuid NOT NULL REFERENCES salary_advances(id) ON DELETE CASCADE,
  amount      numeric(12,2) NOT NULL CHECK (amount > 0),
  kind        text NOT NULL CHECK (kind IN ('payroll', 'cash')),
  pay_run_id  uuid NULL REFERENCES pay_runs(id) ON DELETE SET NULL,
  note        text NOT NULL DEFAULT '',
  by_id       uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_salary_advance_repayments_advance ON salary_advance_repayments (advance_id);
-- A pay run takes each advance's instalment once.
CREATE UNIQUE INDEX uq_salary_advance_repayments_run ON salary_advance_repayments (advance_id, pay_run_id) WHERE pay_run_id IS NOT NULL;

ALTER TABLE payslips ADD COLUMN advance_deduction numeric(12,2) NOT NULL DEFAULT 0 CHECK (advance_deduction >= 0);
ALTER TABLE settings ADD COLUMN advances jsonb NOT NULL DEFAULT '{}';

INSERT INTO permissions (key, "group", label) VALUES
  ('advance.manage', 'Finance', 'Approve, pay out and follow salary advances')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r, (VALUES ('administrator'), ('finance_manager'), ('finance_hr_manager')) AS x(role_key), (VALUES ('advance.manage')) AS p(key)
WHERE r.key = x.role_key
ON CONFLICT DO NOTHING;

-- 4. Supplier price watch (restaurants): when what an ingredient or supply
-- costs goes up by more than this share, the manager is told.
ALTER TABLE restaurant_purchase_order_lines ADD COLUMN previous_cost numeric(12,4) NULL;

-- 5. Vehicles and fuel: the vans, trucks, cars and motorbikes, their
-- papers (insurance, roadworthiness), and every fill-up with its receipt.
CREATE TABLE vehicles (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name              text NOT NULL,
  plate             text NOT NULL DEFAULT '',
  kind              text NOT NULL DEFAULT 'van' CHECK (kind IN ('van', 'truck', 'pickup', 'car', 'motorbike', 'tricycle', 'other')),
  fuel              text NOT NULL DEFAULT 'diesel' CHECK (fuel IN ('petrol', 'diesel', 'gas', 'electric')),
  driver_id         uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  odometer          integer NULL CHECK (odometer IS NULL OR odometer >= 0),
  insurance_until   date NULL,
  roadworthy_until  date NULL,
  service_every_km  integer NULL CHECK (service_every_km IS NULL OR service_every_km > 0),
  last_service_km   integer NULL,
  notes             text NOT NULL DEFAULT '',
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_vehicles_company ON vehicles (company_id) WHERE active;
CREATE UNIQUE INDEX uq_vehicles_plate ON vehicles (upper(plate)) WHERE plate <> '';

CREATE TABLE fuel_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id  uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  day         date NOT NULL,
  litres      numeric(8,2) NOT NULL CHECK (litres > 0),
  amount      numeric(12,2) NOT NULL CHECK (amount > 0),
  odometer    integer NULL CHECK (odometer IS NULL OR odometer >= 0),
  full_tank   boolean NOT NULL DEFAULT true,
  station     text NOT NULL DEFAULT '',
  paid_with   text NOT NULL DEFAULT 'cash' CHECK (paid_with IN ('cash', 'mobile_money', 'card', 'fuel_card', 'account')),
  photo       jsonb NULL,
  note        text NOT NULL DEFAULT '',
  by_id       uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_fuel_logs_vehicle ON fuel_logs (vehicle_id, day DESC);

INSERT INTO permissions (key, "group", label) VALUES
  ('vehicle.read', 'Operations', 'View vehicles and fuel'),
  ('vehicle.manage', 'Operations', 'Add vehicles, their papers and drivers; correct fuel entries')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, x.perm FROM roles r JOIN (VALUES
  ('administrator', 'vehicle.read'), ('administrator', 'vehicle.manage'),
  ('general_manager', 'vehicle.read'), ('general_manager', 'vehicle.manage'),
  ('executive', 'vehicle.read'), ('department_manager', 'vehicle.read'),
  ('finance_manager', 'vehicle.read'), ('finance_hr_manager', 'vehicle.read')
) AS x(role_key, perm) ON x.role_key = r.key
ON CONFLICT DO NOTHING;
