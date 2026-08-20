-- Payroll: employees are paid a daily rate, on one of two cycles (monthly,
-- paid on the 5th, or biweekly — every two weeks). A pay run computes
-- gross pay from Attendance-derived days worked, deducts SSNIT (employee
-- share) and PAYE income tax, and produces one payslip per employee.
-- SSNIT/PAYE rates live in settings.payroll (jsonb, like commercial.taxRates
-- already does for VAT etc.) so Finance can correct them without a code
-- change — see referenceData.js's defaultPayroll() for the seeded starting
-- rates, which must be verified against current GRA/SSNIT circulars.

ALTER TABLE employees ADD COLUMN pay_cycle  text NOT NULL DEFAULT 'monthly' CHECK (pay_cycle IN ('monthly', 'biweekly'));
ALTER TABLE employees ADD COLUMN daily_rate numeric(10,2) NOT NULL DEFAULT 0;

ALTER TABLE settings ADD COLUMN payroll jsonb NOT NULL DEFAULT '{}';

CREATE TABLE pay_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_no        text NOT NULL UNIQUE,
  cycle         text NOT NULL CHECK (cycle IN ('monthly', 'biweekly')),
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  pay_date      date NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'paid')),
  created_by    uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  approved_by   uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  approved_at   timestamptz NULL
);

CREATE TABLE payslips (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pay_run_id      uuid NOT NULL REFERENCES pay_runs(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  days_worked     numeric(5,2) NOT NULL DEFAULT 0,
  daily_rate      numeric(10,2) NOT NULL DEFAULT 0,
  gross_pay       numeric(12,2) NOT NULL DEFAULT 0,
  ssnit_employee  numeric(12,2) NOT NULL DEFAULT 0,
  ssnit_employer  numeric(12,2) NOT NULL DEFAULT 0,
  taxable_income  numeric(12,2) NOT NULL DEFAULT 0,
  paye_tax        numeric(12,2) NOT NULL DEFAULT 0,
  net_pay         numeric(12,2) NOT NULL DEFAULT 0,
  UNIQUE (pay_run_id, employee_id)
);

CREATE INDEX idx_pay_runs_status ON pay_runs(status);
CREATE INDEX idx_payslips_pay_run_id ON payslips(pay_run_id);
CREATE INDEX idx_payslips_employee_id ON payslips(employee_id);
