DROP INDEX idx_employees_tin;
DROP INDEX idx_employees_ssnit_number;
ALTER TABLE employees DROP COLUMN tin, DROP COLUMN ssnit_number;
