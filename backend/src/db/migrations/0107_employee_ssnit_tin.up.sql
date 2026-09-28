-- Employees: SSNIT number and TIN (GRA taxpayer number, which for most
-- people is now their Ghana Card number), for filing PAYE and SSNIT.
-- Seen and changed only with payroll.manage (employees.service.js). Two
-- people can't share one.
ALTER TABLE employees ADD COLUMN ssnit_number text NULL, ADD COLUMN tin text NULL;
CREATE UNIQUE INDEX idx_employees_ssnit_number ON employees (upper(ssnit_number)) WHERE ssnit_number IS NOT NULL;
CREATE UNIQUE INDEX idx_employees_tin ON employees (upper(tin)) WHERE tin IS NOT NULL;
