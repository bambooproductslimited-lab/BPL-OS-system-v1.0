-- Salary for SSNIT: the monthly salary a person's SSNIT is worked out on
-- (staff 5.5%, employer 13%), whatever days they worked. Not set: a
-- salaried person's basic salary; a daily-rate person pays on what they
-- earned in the run. A run shorter than a month charges its share of the
-- month; a run with nothing earned charges none. The payslip keeps the
-- monthly figure it used (null: on basic earned).
ALTER TABLE employees ADD COLUMN ssnit_salary numeric(12,2) NULL CHECK (ssnit_salary IS NULL OR ssnit_salary >= 0);
ALTER TABLE payslips ADD COLUMN ssnit_salary numeric(12,2) NULL;
