-- Each person's date of birth, for "Birthdays this month" in the directory.
-- Colleagues see only the day and month (the birthday); the full date, with
-- the year, only HR (employee.write) and the person themself
-- (employees.service.js rowToEmployee).
ALTER TABLE employees ADD COLUMN date_of_birth date NULL;
