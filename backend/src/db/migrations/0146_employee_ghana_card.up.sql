-- A person's Ghana Card number (GHA-123456789-0), kept like the SSNIT
-- number and TIN: payroll.manage to see or change, one person per number.
ALTER TABLE employees ADD COLUMN ghana_card text NULL;
CREATE UNIQUE INDEX idx_employees_ghana_card ON employees (upper(ghana_card)) WHERE ghana_card IS NOT NULL;
