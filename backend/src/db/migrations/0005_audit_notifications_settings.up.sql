-- kernel.js: audit(), notify(), db.settings

CREATE TABLE audit_logs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at             timestamptz NOT NULL DEFAULT now(),
  actor_user_id  uuid NULL REFERENCES users(id) ON DELETE SET NULL, -- null = system action
  actor_name     text NOT NULL DEFAULT 'System',
  action         text NOT NULL, -- e.g. 'leave.decide'
  entity         text NOT NULL, -- e.g. 'leave_request'
  entity_id      text NOT NULL,
  summary        text NOT NULL,
  meta           jsonb NULL
);

CREATE INDEX idx_audit_logs_at ON audit_logs(at DESC);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity, entity_id);

CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  title        text NOT NULL,
  body         text NOT NULL DEFAULT '',
  link         text NULL,
  at           timestamptz NOT NULL DEFAULT now(),
  read         boolean NOT NULL DEFAULT false
);

CREATE INDEX idx_notifications_employee_id ON notifications(employee_id, read);

-- Singleton settings row (id is always 1), including the nested "commercial"
-- and "integrations" config kernel.js keeps as free-form sub-objects.
CREATE TABLE settings (
  id                    smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  company_name          text NOT NULL DEFAULT 'Bamboo Products Limited',
  short_name            text NOT NULL DEFAULT 'BPL',
  country               text NOT NULL DEFAULT 'Ghana',
  currency              text NOT NULL DEFAULT 'GHS',
  timezone              text NOT NULL DEFAULT 'Africa/Accra',
  fiscal_year_start     text NOT NULL DEFAULT '01-01',
  work_week             text NOT NULL DEFAULT 'Mon–Sat',
  standard_hours        integer NOT NULL DEFAULT 8,
  late_after            time NOT NULL DEFAULT '08:15',
  plants                text[] NOT NULL DEFAULT ARRAY['Tema Plant', 'Accra Office'],
  leave_approval_chain  text[] NOT NULL DEFAULT ARRAY['department_manager', 'hr_manager'],
  commercial            jsonb NOT NULL DEFAULT '{}'::jsonb,
  integrations          jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at            timestamptz NOT NULL DEFAULT now()
);
