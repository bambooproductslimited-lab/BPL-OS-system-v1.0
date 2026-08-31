-- Bamboo OS now covers three separate businesses under one holding company
-- (Bamboo Products Limited, Star Bar Restaurant, Bamboo Garden), each with
-- its own departments. "Group" in the UI becomes "Company" — the top-level
-- org unit departments now belong to. Every department must have a company;
-- for the pre-existing departments (all of which were Bamboo Products
-- Limited) we backfill that before enforcing NOT NULL, so this migration is
-- safe to run against a database that already has department/employee rows.
CREATE TABLE companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE departments ADD COLUMN company_id uuid NULL REFERENCES companies(id) ON DELETE RESTRICT;

INSERT INTO companies (code, name) VALUES ('BPL', 'Bamboo Products Limited');
UPDATE departments SET company_id = (SELECT id FROM companies WHERE code = 'BPL') WHERE company_id IS NULL;

ALTER TABLE departments ALTER COLUMN company_id SET NOT NULL;
CREATE INDEX idx_departments_company_id ON departments(company_id);

-- Named shift templates, scoped to a department (each department can define
-- its own set — "different shifts" per company and department, since a
-- department's company is implied by department_id). Employees pick one via
-- employees.shift_id below; attendance.service.js's resolveLateAfter()
-- resolves lateness against the assigned shift's start_time first, falling
-- back to the pre-existing per-employee shift_start override (migration
-- 0030), then the company-wide settings.late_after default — unchanged for
-- anyone with neither.
CREATE TABLE shifts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  name          text NOT NULL,
  start_time    time NOT NULL,
  end_time      time NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_shifts_department_id ON shifts(department_id);

ALTER TABLE employees ADD COLUMN shift_id uuid NULL REFERENCES shifts(id) ON DELETE SET NULL;
CREATE INDEX idx_employees_shift_id ON employees(shift_id);
