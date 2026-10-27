-- The seventeenth batch: bank reconciliation; budgets against what was
-- spent; staff performance reviews; recruitment (openings, applicants, a
-- public jobs page); staff training and certificates.

-- ── Bank reconciliation ──
-- A bank, Mobile Money or cash account a company keeps; its statement lines
-- imported from the bank's CSV, each matched to money already recorded in
-- the OS (a customer's payment, a bill paid, an advance or a pay run paid
-- out, takings banked from a till) or explained by hand.
CREATE TABLE bank_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name               text NOT NULL,
  kind               text NOT NULL DEFAULT 'bank' CHECK (kind IN ('bank', 'mobile_money', 'cash')),
  bank_name          text NOT NULL DEFAULT '',
  last4              text NOT NULL DEFAULT '',
  currency           text NOT NULL DEFAULT 'GHS',
  reconciled_until   date NULL,
  reconciled_balance numeric(14,2) NULL,
  reconciled_by      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  reconciled_at      timestamptz NULL,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_bank_accounts_company ON bank_accounts (company_id) WHERE active;

CREATE TABLE bank_imports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  filename    text NOT NULL DEFAULT '',
  rows        integer NOT NULL DEFAULT 0,
  added       integer NOT NULL DEFAULT 0,
  duplicates  integer NOT NULL DEFAULT 0,
  matched     integer NOT NULL DEFAULT 0,
  from_day    date NULL,
  to_day      date NULL,
  by_id       uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bank_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  import_id    uuid NULL REFERENCES bank_imports(id) ON DELETE SET NULL,
  day          date NOT NULL,
  description  text NOT NULL DEFAULT '',
  reference    text NOT NULL DEFAULT '',
  amount       numeric(14,2) NOT NULL CHECK (amount <> 0),
  balance      numeric(14,2) NULL,
  fingerprint  text NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'matched', 'explained')),
  match_type   text NULL CHECK (match_type IS NULL OR match_type IN ('payment', 'bill_payment', 'advance', 'pay_run', 'deposit')),
  match_id     uuid NULL,
  category     text NULL,
  note         text NOT NULL DEFAULT '',
  auto         boolean NOT NULL DEFAULT false,
  done_by      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  done_at      timestamptz NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_bank_lines_fingerprint ON bank_lines (account_id, fingerprint);
CREATE INDEX idx_bank_lines_account ON bank_lines (account_id, day DESC);
-- One statement line per thing recorded in the OS.
CREATE UNIQUE INDEX uq_bank_lines_match ON bank_lines (match_type, match_id) WHERE match_id IS NOT NULL;

INSERT INTO permissions (key, "group", label) VALUES
  ('bank.manage', 'Finance', 'Import bank statements and reconcile them')
ON CONFLICT (key) DO NOTHING;

-- ── Budgets ──
-- What each company means to spend in a month, by category (the bills'
-- categories, payroll, expenses, fuel).
CREATE TABLE budgets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  month       date NOT NULL CHECK (extract(day FROM month) = 1),
  category    text NOT NULL,
  amount      numeric(14,2) NOT NULL CHECK (amount >= 0),
  updated_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, month, category)
);
ALTER TABLE settings ADD COLUMN budgets jsonb NOT NULL DEFAULT '{}';

-- ── Performance reviews ──
CREATE TABLE review_rounds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  period_start  date NOT NULL,
  period_end    date NOT NULL CHECK (period_end >= period_start),
  self_due      date NOT NULL,
  due_on        date NOT NULL,
  questions     jsonb NOT NULL DEFAULT '[]',
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_by    uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reviews (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id         uuid NOT NULL REFERENCES review_rounds(id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  reviewer_id      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'self' CHECK (status IN ('self', 'manager', 'done', 'signed')),
  self_scores      jsonb NOT NULL DEFAULT '{}',
  self_comment     text NOT NULL DEFAULT '',
  self_at          timestamptz NULL,
  scores           jsonb NOT NULL DEFAULT '{}',
  strengths        text NOT NULL DEFAULT '',
  improve          text NOT NULL DEFAULT '',
  goals            jsonb NOT NULL DEFAULT '[]',
  overall          numeric(3,1) NULL,
  manager_at       timestamptz NULL,
  employee_comment text NOT NULL DEFAULT '',
  signed_at        timestamptz NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id, employee_id)
);
CREATE INDEX idx_reviews_reviewer ON reviews (reviewer_id, status);
CREATE INDEX idx_reviews_employee ON reviews (employee_id);

-- ── Recruitment ──
CREATE TABLE job_openings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  department_id  uuid NULL REFERENCES departments(id) ON DELETE SET NULL,
  title          text NOT NULL,
  slug           text NOT NULL UNIQUE,
  location       text NOT NULL DEFAULT '',
  kind           text NOT NULL DEFAULT 'full_time' CHECK (kind IN ('full_time', 'part_time', 'contract', 'internship', 'casual')),
  description    text NOT NULL DEFAULT '',
  requirements   text NOT NULL DEFAULT '',
  pay            text NOT NULL DEFAULT '',
  closes_on      date NULL,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
  created_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE job_applicants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opening_id      uuid NOT NULL REFERENCES job_openings(id) ON DELETE CASCADE,
  name            text NOT NULL,
  email           text NOT NULL DEFAULT '',
  phone           text NOT NULL DEFAULT '',
  note            text NOT NULL DEFAULT '',
  cv              jsonb NULL,
  source          text NOT NULL DEFAULT 'website' CHECK (source IN ('website', 'walk_in', 'referral', 'other')),
  stage           text NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'screening', 'interview', 'offer', 'hired', 'rejected')),
  rating          smallint NULL CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  interview_at    timestamptz NULL,
  interviewer_id  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  reject_reason   text NOT NULL DEFAULT '',
  employee_id     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  ip              text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_job_applicants_opening ON job_applicants (opening_id, stage);
CREATE TABLE job_applicant_notes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id  uuid NOT NULL REFERENCES job_applicants(id) ON DELETE CASCADE,
  by_id         uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  text          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── Training and certificates ──
CREATE TABLE cert_types (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL UNIQUE,
  valid_months  integer NULL CHECK (valid_months IS NULL OR valid_months > 0),
  required_for  uuid[] NOT NULL DEFAULT '{}',
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- The ones most of the companies need, to start with; more are added in the OS.
INSERT INTO cert_types (name, valid_months) VALUES
  ('Food handler''s health certificate', 12), ('Fire safety', 24), ('First aid', 24), ('Forklift licence', 36), ('Driving licence', NULL)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE staff_certs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type_id      uuid NOT NULL REFERENCES cert_types(id) ON DELETE CASCADE,
  number       text NOT NULL DEFAULT '',
  issuer       text NOT NULL DEFAULT '',
  issued_on    date NULL,
  expires_on   date NULL,
  photo        jsonb NULL,
  note         text NOT NULL DEFAULT '',
  verified_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  verified_at  timestamptz NULL,
  created_by   uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_staff_certs_employee ON staff_certs (employee_id, type_id);
CREATE TABLE trainings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NULL REFERENCES companies(id) ON DELETE SET NULL,
  title       text NOT NULL,
  type_id     uuid NULL REFERENCES cert_types(id) ON DELETE SET NULL,
  day         date NOT NULL,
  starts      time NULL,
  hours       numeric(4,1) NULL,
  location    text NOT NULL DEFAULT '',
  trainer     text NOT NULL DEFAULT '',
  notes       text NOT NULL DEFAULT '',
  created_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE training_attendees (
  training_id  uuid NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'attended', 'missed')),
  PRIMARY KEY (training_id, employee_id)
);

INSERT INTO permissions (key, "group", label) VALUES
  ('review.manage', 'People', 'Run performance reviews and read every review'),
  ('recruit.manage', 'People', 'Post jobs and manage applicants'),
  ('training.manage', 'People', 'Record staff certificates and training')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, x.perm FROM roles r JOIN (VALUES
  ('administrator', 'bank.manage'), ('finance_manager', 'bank.manage'), ('finance_hr_manager', 'bank.manage'),
  ('administrator', 'review.manage'), ('hr_manager', 'review.manage'), ('finance_hr_manager', 'review.manage'), ('general_manager', 'review.manage'),
  ('administrator', 'recruit.manage'), ('hr_manager', 'recruit.manage'), ('finance_hr_manager', 'recruit.manage'), ('general_manager', 'recruit.manage'),
  ('administrator', 'training.manage'), ('hr_manager', 'training.manage'), ('finance_hr_manager', 'training.manage'), ('general_manager', 'training.manage')
) AS x(role_key, perm) ON x.role_key = r.key
ON CONFLICT DO NOTHING;
