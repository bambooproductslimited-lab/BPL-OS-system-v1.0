-- Employment type set is now permanent / contract / casual / day_rate
-- ("By day" in the UI — paid strictly per day worked), replacing the
-- unused 'intern' option. Convert any existing 'intern' rows first so the
-- new CHECK constraint doesn't reject them.
UPDATE employees SET employment_type = 'casual' WHERE employment_type = 'intern';

ALTER TABLE employees DROP CONSTRAINT employees_employment_type_check;
ALTER TABLE employees ADD CONSTRAINT employees_employment_type_check
  CHECK (employment_type IN ('permanent', 'contract', 'casual', 'day_rate'));
