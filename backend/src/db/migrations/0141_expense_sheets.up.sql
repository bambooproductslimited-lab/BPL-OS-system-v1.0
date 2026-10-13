-- Officers' expense sheets (services/expenseSheets.service.js): the float
-- (imprest) each officer is given to spend for the company, kept as their
-- own sheet. Finance tops it up (funding); the officer writes down every
-- spend (date, amount, quantity, what for, who was paid, the category, the
-- company, site or job it was for, and the vehicle or machine if any); the
-- balance runs line by line, so it is cash in hand while positive and owed
-- to the officer when below zero. A supervisor, and finance, check a sheet
-- up to a date: the balance on that date is confirmed, cash counted if they
-- want, and everything up to then is locked. Officers ask for top-ups.
-- Until now this lived in one spreadsheet per officer
-- (expenseSheetImport.service.js brings those in).

CREATE TABLE expense_sheets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    uuid NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
  supervisor_id  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  float_limit    numeric(14,2) NULL CHECK (float_limit IS NULL OR float_limit >= 0),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  note           text NOT NULL DEFAULT '',
  created_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- A check: everything up to upto_date confirmed at that day's balance.
CREATE TABLE expense_sheet_checks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id     uuid NOT NULL REFERENCES expense_sheets(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('supervisor', 'accountant')),
  upto_date    date NOT NULL,
  balance      numeric(14,2) NOT NULL,
  counted      numeric(14,2) NULL,
  code         text NOT NULL,
  note         text NOT NULL DEFAULT '',
  by_id        uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  by_initials  text NOT NULL DEFAULT '',
  source       text NOT NULL DEFAULT 'os' CHECK (source IN ('os', 'import')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_expense_sheet_checks_sheet ON expense_sheet_checks (sheet_id, upto_date);

-- Funding is money given to the officer (amount > 0, payee = who gave it).
-- An expense may be below zero for money that came back (a loan repaid, a
-- refund), with a note saying so. seq is the sheet's own running number.
CREATE TABLE expense_sheet_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id      uuid NOT NULL REFERENCES expense_sheets(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('funding', 'expense')),
  seq           integer NOT NULL,
  date          date NOT NULL,
  amount        numeric(14,2) NOT NULL CHECK (amount <> 0),
  qty           numeric(12,3) NOT NULL DEFAULT 1 CHECK (qty > 0),
  note          text NOT NULL DEFAULT '',
  payee         text NOT NULL DEFAULT '',
  category      text NOT NULL DEFAULT '',
  subcategory   text NOT NULL DEFAULT '',
  cost_centre   text NOT NULL DEFAULT '',
  company_id    uuid NULL REFERENCES companies(id) ON DELETE SET NULL,
  asset         text NOT NULL DEFAULT '',
  asset_id      uuid NULL REFERENCES assets(id) ON DELETE SET NULL,
  receipt_key   text NULL,
  receipt_name  text NULL,
  receipt_type  text NULL,
  audit_note    text NOT NULL DEFAULT '',
  source        text NOT NULL DEFAULT 'os' CHECK (source IN ('os', 'import', 'topup')),
  import_key    text NULL,
  created_by    uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'expense' OR amount > 0),
  UNIQUE (sheet_id, seq)
);
CREATE INDEX idx_expense_sheet_lines_sheet ON expense_sheet_lines (sheet_id, date, seq);
CREATE UNIQUE INDEX idx_expense_sheet_lines_import ON expense_sheet_lines (sheet_id, import_key) WHERE import_key IS NOT NULL;

CREATE TABLE expense_sheet_topups (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id       uuid NOT NULL REFERENCES expense_sheets(id) ON DELETE CASCADE,
  amount         numeric(14,2) NOT NULL CHECK (amount > 0),
  reason         text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
  requested_by   uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  decided_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  decided_at     timestamptz NULL,
  decision_note  text NOT NULL DEFAULT '',
  line_id        uuid NULL REFERENCES expense_sheet_lines(id) ON DELETE SET NULL
);
CREATE INDEX idx_expense_sheet_topups_sheet ON expense_sheet_topups (sheet_id, status);

-- The categories to choose from, and the cost centres (a company, a site,
-- a job) spends are charged to. A cost centre may belong to a company.
CREATE TABLE expense_sheet_lists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('category', 'cost_centre')),
  name        text NOT NULL,
  company_id  uuid NULL REFERENCES companies(id) ON DELETE SET NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_expense_sheet_lists_name ON expense_sheet_lists (kind, lower(name));

-- The usual categories, and every company as a cost centre, are put in the
-- first time the lists are read (expenseSheets.service.js ensureLists).

INSERT INTO permissions (key, "group", label) VALUES
  ('expensesheet.read.all', 'Finance', 'View every officer''s expense sheet'),
  ('expensesheet.manage', 'Finance', 'Run expense sheets: open, fund, check, import')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r
JOIN (VALUES
  ('administrator', 'expensesheet.read.all'), ('administrator', 'expensesheet.manage'),
  ('finance_manager', 'expensesheet.read.all'), ('finance_manager', 'expensesheet.manage'),
  ('finance_hr_manager', 'expensesheet.read.all'), ('finance_hr_manager', 'expensesheet.manage'),
  ('executive', 'expensesheet.read.all'), ('general_manager', 'expensesheet.read.all')
) AS p(role_key, key) ON p.role_key = r.key
ON CONFLICT DO NOTHING;
