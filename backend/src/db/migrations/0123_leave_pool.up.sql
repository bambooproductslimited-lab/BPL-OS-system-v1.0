-- One yearly leave total per person (leave.service.js poolFor): annual,
-- compassionate and sick leave all come out of the days agreed with the
-- employee — or their company's default — less that year's company
-- holidays, taken off on 1 January. Taking more than is left is allowed;
-- the days over are owed, recorded, and settled by HR.
--
-- in_pool: whether a leave type counts toward that total. Unpaid leave and
-- maternity/paternity stay outside it, with their own rules as before.
ALTER TABLE leave_types ADD COLUMN in_pool boolean NOT NULL DEFAULT true;
UPDATE leave_types SET in_pool = false WHERE NOT paid OR name ~* '(matern|patern)';

-- The total for everyone in a company who has no total of their own.
ALTER TABLE companies ADD COLUMN leave_days_default integer NULL CHECK (leave_days_default IS NULL OR leave_days_default >= 0);

-- How owed days were settled: HR's decision in each case.
CREATE TABLE leave_owed_settlements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  year        integer NOT NULL,
  days        numeric(6,1) NOT NULL CHECK (days > 0),
  how         text NOT NULL CHECK (how IN ('pay', 'next_year', 'waived', 'other')),
  note        text NOT NULL DEFAULT '',
  settled_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_leave_owed_settlements_emp ON leave_owed_settlements (employee_id, year);
