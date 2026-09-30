DELETE FROM attendance WHERE shift_no = 2;
ALTER TABLE attendance DROP CONSTRAINT attendance_employee_date_shift_key;
ALTER TABLE attendance ADD CONSTRAINT attendance_employee_id_date_key UNIQUE (employee_id, date);
ALTER TABLE attendance DROP COLUMN shift_no;
ALTER TABLE employees DROP CONSTRAINT employees_second_shift_both, DROP COLUMN second_shift_start, DROP COLUMN second_shift_end;
