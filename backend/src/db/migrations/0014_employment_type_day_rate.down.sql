UPDATE employees SET employment_type = 'intern' WHERE employment_type = 'day_rate';

ALTER TABLE employees DROP CONSTRAINT employees_employment_type_check;
ALTER TABLE employees ADD CONSTRAINT employees_employment_type_check
  CHECK (employment_type IN ('permanent', 'contract', 'casual', 'intern'));
