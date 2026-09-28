-- Payroll: basic salary and allowance. An employee can have a monthly basic
-- and allowance instead of a daily rate; a pay run then pays them cut by
-- the days they were paid for (worked, or on paid leave) out of the
-- month's working days. SSNIT is on basic only, and the allowance is not
-- taxed (PAYE on basic less staff SSNIT). Both can be changed on a draft
-- payslip for that run alone.
ALTER TABLE employees ADD COLUMN basic_salary numeric(12,2) NULL, ADD COLUMN allowance numeric(12,2) NULL;

ALTER TABLE payslips
  ADD COLUMN pay_basis text NOT NULL DEFAULT 'daily' CHECK (pay_basis IN ('daily', 'salary')),
  ADD COLUMN basic_pay numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN allowance_pay numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN monthly_basic numeric(12,2) NULL,
  ADD COLUMN monthly_allowance numeric(12,2) NULL,
  ADD COLUMN working_days integer NULL,
  ADD COLUMN month_working_days integer NULL,
  ADD COLUMN amounts_edited boolean NOT NULL DEFAULT false;
-- Every payslip so far was days x daily rate: all of it basic.
UPDATE payslips SET basic_pay = gross_pay;
