-- The nineteenth batch: discipline and grievances (discipline.service.js),
-- quality inspections (quality.service.js), staff voice — pulse surveys and
-- the ideas box (voice.service.js), goals — objectives and key results
-- (goals.service.js), uniforms and PPE (ppe.service.js).

-- ── Discipline and grievances ──
-- One matter: a disciplinary case about someone (kind discipline) or a
-- grievance someone raised (kind grievance, employee_id is who raised it,
-- against_id who it is about). Confidential: discipline.manage, the person
-- it is about once a query has gone to them, the person who raised it.
CREATE TABLE discipline_cases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          integer NOT NULL UNIQUE,
  kind            text NOT NULL CHECK (kind IN ('discipline', 'grievance')),
  employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  against_id      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  category        text NOT NULL DEFAULT 'other',
  title           text NOT NULL,
  details         text NOT NULL DEFAULT '',
  occurred_on     date NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'awaiting_reply', 'hearing', 'decided', 'appealed', 'closed', 'withdrawn')),
  handler_id      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  query_text      text NOT NULL DEFAULT '',
  query_sent_at   timestamptz NULL,
  reply_due       date NULL,
  reply_text      text NOT NULL DEFAULT '',
  replied_at      timestamptz NULL,
  hearing_at      timestamptz NULL,
  hearing_place   text NOT NULL DEFAULT '',
  panel           jsonb NOT NULL DEFAULT '[]',
  outcome         text NULL CHECK (outcome IS NULL OR outcome IN ('no_action', 'counselling', 'verbal_warning', 'written_warning', 'final_warning', 'suspension', 'dismissal', 'upheld', 'partly_upheld', 'not_upheld')),
  outcome_note    text NOT NULL DEFAULT '',
  suspension_days integer NOT NULL DEFAULT 0,
  warning_until   date NULL,
  decided_at      timestamptz NULL,
  decided_by      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  appeal_text     text NOT NULL DEFAULT '',
  appealed_at     timestamptz NULL,
  appeal_result   text NULL CHECK (appeal_result IS NULL OR appeal_result IN ('stands', 'reduced', 'overturned')),
  appeal_note     text NOT NULL DEFAULT '',
  appeal_decided_at timestamptz NULL,
  created_by      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX discipline_cases_employee ON discipline_cases (employee_id);
CREATE INDEX discipline_cases_open ON discipline_cases (status) WHERE status NOT IN ('closed', 'withdrawn');

-- What happened, in order: notes, the query, the reply, the hearing, the
-- outcome, the appeal. who_sees: hr (only those handling it) or both.
CREATE TABLE discipline_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES discipline_cases(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('opened', 'note', 'query', 'reply', 'hearing', 'outcome', 'appeal', 'appeal_result', 'closed', 'withdrawn', 'reopened')),
  body        text NOT NULL DEFAULT '',
  shared      boolean NOT NULL DEFAULT false,
  by_id       uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX discipline_events_case ON discipline_events (case_id, at);

-- ── Quality inspections ──
-- A checklist for a product or a stage: points to check (ok / not ok) or to
-- measure (a value between min and max); a critical point failing fails the lot.
CREATE TABLE qc_checklists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  stage       text NOT NULL DEFAULT 'final' CHECK (stage IN ('incoming', 'in_process', 'final', 'packing')),
  product_id  uuid NULL REFERENCES products(id) ON DELETE SET NULL,
  points      jsonb NOT NULL DEFAULT '[]',
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One inspection of a lot: a production batch, or anything else by its own
-- reference (bamboo arriving, a customer's order before it goes).
CREATE TABLE qc_inspections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        integer NOT NULL UNIQUE,
  checklist_id  uuid NULL REFERENCES qc_checklists(id) ON DELETE SET NULL,
  batch_id      uuid NULL REFERENCES production_batches(id) ON DELETE SET NULL,
  product_id    uuid NULL REFERENCES products(id) ON DELETE SET NULL,
  stage         text NOT NULL DEFAULT 'final' CHECK (stage IN ('incoming', 'in_process', 'final', 'packing')),
  lot_ref       text NOT NULL DEFAULT '',
  lot_qty       numeric(14,2) NOT NULL DEFAULT 0,
  sample_size   integer NOT NULL DEFAULT 0,
  results       jsonb NOT NULL DEFAULT '[]',
  verdict       text NOT NULL CHECK (verdict IN ('pass', 'pass_notes', 'hold', 'fail')),
  disposition   text NULL CHECK (disposition IS NULL OR disposition IN ('release', 'rework', 'scrap', 'return')),
  rework_qty    numeric(14,2) NOT NULL DEFAULT 0,
  scrap_qty     numeric(14,2) NOT NULL DEFAULT 0,
  note          text NOT NULL DEFAULT '',
  inspector_id  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  inspected_at  timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz NULL,
  settled_by    uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  settle_note   text NOT NULL DEFAULT '',
  first_pass    boolean NOT NULL DEFAULT true
);
CREATE INDEX qc_inspections_batch ON qc_inspections (batch_id);
CREATE INDEX qc_inspections_open ON qc_inspections (verdict) WHERE settled_at IS NULL;

-- The defects found, by type, with how many and how bad, and photos.
CREATE TABLE qc_defects (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id  uuid NOT NULL REFERENCES qc_inspections(id) ON DELETE CASCADE,
  type           text NOT NULL,
  qty            integer NOT NULL DEFAULT 1 CHECK (qty > 0),
  severity       text NOT NULL DEFAULT 'minor' CHECK (severity IN ('minor', 'major', 'critical')),
  note           text NOT NULL DEFAULT '',
  photo          jsonb NULL
);
CREATE INDEX qc_defects_inspection ON qc_defects (inspection_id);

-- ── Staff voice ──
-- A pulse survey: a few questions to everyone, a company or a department.
-- Anonymous: the answers keep no name, only a hash that stops the same
-- person answering twice (voice.service.js), and a group's answers are only
-- shown once enough people in it have answered.
CREATE TABLE voice_surveys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL,
  intro         text NOT NULL DEFAULT '',
  questions     jsonb NOT NULL DEFAULT '[]',
  company_id    uuid NULL REFERENCES companies(id) ON DELETE SET NULL,
  department_id uuid NULL REFERENCES departments(id) ON DELETE SET NULL,
  anonymous     boolean NOT NULL DEFAULT true,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
  opens_on      date NULL,
  closes_on     date NULL,
  invited       integer NOT NULL DEFAULT 0,
  created_by    uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz NULL
);

CREATE TABLE voice_responses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id     uuid NOT NULL REFERENCES voice_surveys(id) ON DELETE CASCADE,
  token         text NOT NULL,
  employee_id   uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  department_id uuid NULL REFERENCES departments(id) ON DELETE SET NULL,
  answers       jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (survey_id, token)
);

-- The ideas box: anyone shares an idea, everyone votes, whoever runs it
-- answers and moves it along. An anonymous idea never shows its author.
CREATE TABLE voice_ideas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        integer NOT NULL UNIQUE,
  title         text NOT NULL,
  body          text NOT NULL DEFAULT '',
  category      text NOT NULL DEFAULT 'other',
  author_id     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  anonymous     boolean NOT NULL DEFAULT false,
  company_id    uuid NULL REFERENCES companies(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewing', 'planned', 'done', 'not_now')),
  response      text NOT NULL DEFAULT '',
  responded_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  responded_at  timestamptz NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE voice_votes (
  idea_id      uuid NOT NULL REFERENCES voice_ideas(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (idea_id, employee_id)
);

-- ── Goals ──
-- Objectives for a quarter (period '2026-Q4'), the company's or a team's
-- (department), a team's lined up under one of the company's; each has key
-- results with a start, a target and where it is now.
CREATE TABLE goal_objectives (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period        text NOT NULL CHECK (period ~ '^\d{4}-Q[1-4]$'),
  level         text NOT NULL DEFAULT 'company' CHECK (level IN ('company', 'team')),
  title         text NOT NULL,
  why           text NOT NULL DEFAULT '',
  company_id    uuid NULL REFERENCES companies(id) ON DELETE SET NULL,
  department_id uuid NULL REFERENCES departments(id) ON DELETE SET NULL,
  parent_id     uuid NULL REFERENCES goal_objectives(id) ON DELETE SET NULL,
  owner_id      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'dropped')),
  seq           integer NOT NULL DEFAULT 0,
  created_by    uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX goal_objectives_period ON goal_objectives (period);

CREATE TABLE goal_key_results (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  objective_id  uuid NOT NULL REFERENCES goal_objectives(id) ON DELETE CASCADE,
  title         text NOT NULL,
  kind          text NOT NULL DEFAULT 'number' CHECK (kind IN ('number', 'percent', 'money', 'done')),
  unit          text NOT NULL DEFAULT '',
  start_value   numeric(16,2) NOT NULL DEFAULT 0,
  target_value  numeric(16,2) NOT NULL DEFAULT 1,
  current_value numeric(16,2) NOT NULL DEFAULT 0,
  confidence    text NOT NULL DEFAULT 'on_track' CHECK (confidence IN ('on_track', 'at_risk', 'off_track')),
  owner_id      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  seq           integer NOT NULL DEFAULT 0,
  checked_at    timestamptz NULL
);
CREATE INDEX goal_key_results_objective ON goal_key_results (objective_id);

CREATE TABLE goal_checkins (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_result_id  uuid NOT NULL REFERENCES goal_key_results(id) ON DELETE CASCADE,
  value          numeric(16,2) NOT NULL,
  confidence     text NOT NULL CHECK (confidence IN ('on_track', 'at_risk', 'off_track')),
  note           text NOT NULL DEFAULT '',
  by_id          uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX goal_checkins_kr ON goal_checkins (key_result_id, at);

-- ── Uniforms and PPE ──
-- What the company hands out: a uniform or a piece of protective kit, its
-- sizes, how long it lasts before it is replaced, what it costs, and the
-- departments that must have it.
CREATE TABLE ppe_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  kind          text NOT NULL DEFAULT 'ppe' CHECK (kind IN ('ppe', 'uniform')),
  sizes         jsonb NOT NULL DEFAULT '[]',
  life_months   integer NOT NULL DEFAULT 12 CHECK (life_months BETWEEN 0 AND 120),
  unit_cost     numeric(12,2) NOT NULL DEFAULT 0,
  required_for  jsonb NOT NULL DEFAULT '[]',
  per_person    integer NOT NULL DEFAULT 1 CHECK (per_person BETWEEN 1 AND 10),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- How many of each size are in the store, and when to buy more.
CREATE TABLE ppe_stock (
  item_id   uuid NOT NULL REFERENCES ppe_items(id) ON DELETE CASCADE,
  size      text NOT NULL DEFAULT '',
  qty       integer NOT NULL DEFAULT 0 CHECK (qty >= 0),
  min_qty   integer NOT NULL DEFAULT 0 CHECK (min_qty >= 0),
  PRIMARY KEY (item_id, size)
);

-- Handed to someone: until it comes back, is replaced or is lost.
CREATE TABLE ppe_issues (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       uuid NOT NULL REFERENCES ppe_items(id) ON DELETE CASCADE,
  size          text NOT NULL DEFAULT '',
  qty           integer NOT NULL DEFAULT 1 CHECK (qty > 0),
  employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  issued_on     date NOT NULL DEFAULT current_date,
  due_on        date NULL,
  status        text NOT NULL DEFAULT 'out' CHECK (status IN ('out', 'returned', 'replaced', 'lost')),
  ended_on      date NULL,
  condition     text NOT NULL DEFAULT '',
  cost          numeric(12,2) NOT NULL DEFAULT 0,
  note          text NOT NULL DEFAULT '',
  issued_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ppe_issues_employee ON ppe_issues (employee_id);
CREATE INDEX ppe_issues_out ON ppe_issues (due_on) WHERE status = 'out';

-- Someone asks for one (new, worn out, damaged, lost, wrong size).
CREATE TABLE ppe_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  item_id       uuid NOT NULL REFERENCES ppe_items(id) ON DELETE CASCADE,
  size          text NOT NULL DEFAULT '',
  reason        text NOT NULL DEFAULT 'new' CHECK (reason IN ('new', 'worn', 'damaged', 'lost', 'size')),
  note          text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'issued', 'declined', 'cancelled')),
  decided_by    uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  decided_at    timestamptz NULL,
  decline_note  text NOT NULL DEFAULT '',
  issue_id      uuid NULL REFERENCES ppe_issues(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Each person's sizes, set by them in My space: { "item id": "L" }.
CREATE TABLE ppe_sizes (
  employee_id  uuid PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  sizes        jsonb NOT NULL DEFAULT '{}',
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- A leaver hands back their uniforms and kit too (onboarding.service.js).
ALTER TABLE onboard_steps DROP CONSTRAINT onboard_steps_kind_check;
ALTER TABLE onboard_steps ADD CONSTRAINT onboard_steps_kind_check CHECK (kind IN ('task', 'device', 'tool', 'asset', 'ppe', 'final_pay', 'exit_interview', 'mark_left'));

-- Permissions (db/referenceData.js gives them to the roles).
INSERT INTO permissions (key, "group", label) VALUES
  ('discipline.manage', 'People', 'Handle disciplinary cases and grievances (confidential)'),
  ('quality.manage', 'Operations', 'Inspect batches, record defects and release or hold them'),
  ('voice.manage', 'People', 'Run staff surveys and answer the ideas box'),
  ('goals.manage', 'Overview', 'Set the company''s and teams'' objectives and key results'),
  ('ppe.manage', 'Operations', 'Issue uniforms and protective kit and keep their stock')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r JOIN (VALUES
  ('administrator', 'discipline.manage'), ('administrator', 'quality.manage'), ('administrator', 'voice.manage'), ('administrator', 'goals.manage'), ('administrator', 'ppe.manage'),
  ('hr_manager', 'discipline.manage'), ('hr_manager', 'voice.manage'), ('hr_manager', 'ppe.manage'),
  ('finance_hr_manager', 'discipline.manage'), ('finance_hr_manager', 'voice.manage'), ('finance_hr_manager', 'ppe.manage'),
  ('general_manager', 'discipline.manage'), ('general_manager', 'quality.manage'), ('general_manager', 'voice.manage'), ('general_manager', 'goals.manage'), ('general_manager', 'ppe.manage'),
  ('executive', 'voice.manage'), ('executive', 'goals.manage'),
  ('department_manager', 'quality.manage'), ('department_manager', 'goals.manage'), ('department_manager', 'ppe.manage'),
  ('supervisor', 'quality.manage'), ('supervisor', 'ppe.manage')
) AS p(role, key) ON p.role = r.key
ON CONFLICT DO NOTHING;
