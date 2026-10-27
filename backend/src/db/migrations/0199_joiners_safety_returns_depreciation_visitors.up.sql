-- The eighteenth batch: joiners and leavers (onboarding.service.js), health
-- and safety (safety.service.js), statutory returns (returns.service.js),
-- asset depreciation and disposals (depreciation.service.js), visitors and
-- gate passes (visitors.service.js).

-- ── Joiners and leavers ──
-- A company's own list of steps for someone starting or leaving; without
-- one, the built-in steps are used (onboarding.service.js DEFAULTS).
CREATE TABLE onboard_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('join', 'leave')),
  company_id  uuid NULL REFERENCES companies(id) ON DELETE CASCADE,
  steps       jsonb NOT NULL DEFAULT '[]',
  updated_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX onboard_templates_one ON onboard_templates (kind, coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- One person's checklist: their first day (join) or their last (leave).
CREATE TABLE onboard_lists (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('join', 'leave')),
  day          date NOT NULL,
  reason       text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  exit         jsonb NULL,
  created_by   uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  done_at      timestamptz NULL
);
CREATE UNIQUE INDEX onboard_lists_one_open ON onboard_lists (employee_id, kind) WHERE status = 'open';

-- Its steps: whose they are (HR, IT, finance, their manager, the person),
-- when, and for a leaver what they hand back.
CREATE TABLE onboard_steps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id      uuid NOT NULL REFERENCES onboard_lists(id) ON DELETE CASCADE,
  seq          integer NOT NULL,
  title        text NOT NULL,
  owner        text NOT NULL CHECK (owner IN ('hr', 'it', 'finance', 'manager', 'person')),
  assignee_id  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  due_on       date NOT NULL,
  kind         text NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'device', 'tool', 'asset', 'final_pay', 'exit_interview', 'mark_left')),
  ref_id       uuid NULL,
  note         text NOT NULL DEFAULT '',
  done_at      timestamptz NULL,
  done_by      uuid NULL REFERENCES employees(id) ON DELETE SET NULL
);
CREATE INDEX onboard_steps_list ON onboard_steps (list_id, seq);
CREATE INDEX onboard_steps_open ON onboard_steps (assignee_id) WHERE done_at IS NULL;

-- ── Health and safety ──
CREATE TABLE incidents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number           integer NOT NULL UNIQUE,
  company_id       uuid NULL REFERENCES companies(id) ON DELETE SET NULL,
  kind             text NOT NULL CHECK (kind IN ('injury', 'near_miss', 'property_damage', 'fire', 'food_safety', 'vehicle', 'environment', 'security', 'other')),
  severity         text NOT NULL DEFAULT 'low' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  occurred_at      timestamptz NOT NULL,
  location         text NOT NULL DEFAULT '',
  description      text NOT NULL,
  injured_id       uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  injured_name     text NOT NULL DEFAULT '',
  injury           text NOT NULL DEFAULT '',
  treatment        text NOT NULL DEFAULT 'none' CHECK (treatment IN ('none', 'first_aid', 'clinic', 'hospital')),
  lost_days        integer NOT NULL DEFAULT 0 CHECK (lost_days >= 0),
  photos           jsonb NOT NULL DEFAULT '[]',
  immediate_action text NOT NULL DEFAULT '',
  root_cause       text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'investigating', 'closed')),
  investigator_id  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  reported_by      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  closed_at        timestamptz NULL,
  closed_by        uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incidents_when ON incidents (company_id, occurred_at DESC);

CREATE TABLE incident_actions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id  uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  title        text NOT NULL,
  owner_id     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  due_on       date NOT NULL,
  done_at      timestamptz NULL,
  done_by      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  note         text NOT NULL DEFAULT '',
  created_by   uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incident_actions_open ON incident_actions (owner_id, due_on) WHERE done_at IS NULL;

-- ── Statutory returns ──
-- What was filed and paid for one company, one tax, one month; the amounts
-- due are worked out from payroll, invoices and the tills each time.
CREATE TABLE tax_returns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('paye', 'ssnit', 'vat', 'wht')),
  period       date NOT NULL,
  amount       numeric(14,2) NULL,
  input_vat    numeric(14,2) NULL,
  filed_on     date NULL,
  filed_ref    text NOT NULL DEFAULT '',
  paid_on      date NULL,
  paid_amount  numeric(14,2) NULL,
  paid_ref     text NOT NULL DEFAULT '',
  receipt      jsonb NULL,
  note         text NOT NULL DEFAULT '',
  updated_by   uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, kind, period)
);

-- ── Asset depreciation and disposals ──
ALTER TABLE assets
  ADD COLUMN depreciation_method text NULL CHECK (depreciation_method IN ('straight', 'reducing', 'none')),
  ADD COLUMN useful_life_months integer NULL CHECK (useful_life_months IS NULL OR useful_life_months > 0),
  ADD COLUMN reducing_rate numeric(5,2) NULL CHECK (reducing_rate IS NULL OR (reducing_rate > 0 AND reducing_rate <= 100)),
  ADD COLUMN residual_value numeric(14,2) NOT NULL DEFAULT 0 CHECK (residual_value >= 0),
  ADD COLUMN depreciation_from date NULL,
  ADD COLUMN disposed_on date NULL,
  ADD COLUMN disposal_kind text NULL CHECK (disposal_kind IN ('sold', 'scrapped', 'donated', 'lost', 'stolen')),
  ADD COLUMN disposal_amount numeric(14,2) NULL,
  ADD COLUMN disposal_note text NOT NULL DEFAULT '',
  ADD COLUMN disposed_by uuid NULL REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE settings ADD COLUMN depreciation jsonb NOT NULL DEFAULT '{}';

-- ── Visitors and gate passes ──
CREATE TABLE visitors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NULL REFERENCES companies(id) ON DELETE SET NULL,
  name           text NOT NULL,
  phone          text NOT NULL DEFAULT '',
  email          text NOT NULL DEFAULT '',
  from_org       text NOT NULL DEFAULT '',
  host_id        uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  purpose        text NOT NULL DEFAULT 'meeting' CHECK (purpose IN ('meeting', 'delivery', 'interview', 'contractor', 'customer', 'official', 'other')),
  expected_at    timestamptz NULL,
  arrived_at     timestamptz NULL,
  left_at        timestamptz NULL,
  badge          text NOT NULL DEFAULT '',
  vehicle        text NOT NULL DEFAULT '',
  code           text NOT NULL UNIQUE,
  status         text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected', 'in', 'out', 'cancelled')),
  note           text NOT NULL DEFAULT '',
  created_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  signed_in_by   uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  signed_out_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX visitors_day ON visitors (coalesce(arrived_at, expected_at));

CREATE TABLE gate_passes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          integer NOT NULL UNIQUE,
  company_id      uuid NULL REFERENCES companies(id) ON DELETE SET NULL,
  items           jsonb NOT NULL DEFAULT '[]',
  carrier         text NOT NULL DEFAULT '',
  vehicle         text NOT NULL DEFAULT '',
  reason          text NOT NULL DEFAULT 'delivery' CHECK (reason IN ('delivery', 'repair', 'loan', 'return_to_supplier', 'sold', 'disposal', 'other')),
  returnable      boolean NOT NULL DEFAULT false,
  back_by         date NULL,
  note            text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'out', 'back')),
  requested_by    uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  approved_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  approved_at     timestamptz NULL,
  reject_reason   text NOT NULL DEFAULT '',
  out_at          timestamptz NULL,
  out_by          uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  back_at         timestamptz NULL,
  back_checked_by uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Permissions: onboard.manage, safety.manage, returns.manage, visitor.manage
-- and gatepass.approve (db/referenceData.js gives them to the roles).
INSERT INTO permissions (key, "group", label) VALUES
  ('onboard.manage', 'People', 'Run joiners'' and leavers'' checklists'),
  ('safety.manage', 'People', 'Investigate incidents and track safety actions'),
  ('returns.manage', 'Finance', 'File and pay PAYE, SSNIT, VAT and withholding returns'),
  ('visitor.manage', 'Operations', 'Sign visitors in and out; check gate passes at the gate'),
  ('gatepass.approve', 'Operations', 'Approve goods leaving on a gate pass')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r JOIN (VALUES
  ('administrator', 'onboard.manage'), ('administrator', 'safety.manage'), ('administrator', 'returns.manage'), ('administrator', 'visitor.manage'), ('administrator', 'gatepass.approve'),
  ('hr_manager', 'onboard.manage'), ('hr_manager', 'safety.manage'), ('hr_manager', 'visitor.manage'),
  ('finance_hr_manager', 'onboard.manage'), ('finance_hr_manager', 'safety.manage'), ('finance_hr_manager', 'returns.manage'), ('finance_hr_manager', 'visitor.manage'),
  ('general_manager', 'onboard.manage'), ('general_manager', 'safety.manage'), ('general_manager', 'visitor.manage'), ('general_manager', 'gatepass.approve'),
  ('finance_manager', 'returns.manage'),
  ('executive', 'gatepass.approve'), ('department_manager', 'gatepass.approve')
) AS p(role, key) ON p.role = r.key
ON CONFLICT DO NOTHING;
