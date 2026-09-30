-- Some staff work two shifts in a day: a day shift and, after a break, a
-- night shift. Until now attendance held one row per person per day, so the
-- kiosk refused the second clock-in ("already clocked in and out today"),
-- TimeStation's two shifts were merged into one (the break counted as work),
-- and the second shift was never paid.
--
-- The second shift is set on the employee, as times (both or neither), and
-- a day can hold one attendance row per shift: shift_no 1 is their usual
-- shift, 2 the second. A clock-in goes to whichever of their two shifts
-- starts nearest the tap; lateness and the automatic clock-out follow that
-- shift. Each shift worked counts as a day for pay.
ALTER TABLE employees
  ADD COLUMN second_shift_start time NULL,
  ADD COLUMN second_shift_end time NULL,
  ADD CONSTRAINT employees_second_shift_both CHECK ((second_shift_start IS NULL) = (second_shift_end IS NULL));

ALTER TABLE attendance ADD COLUMN shift_no smallint NOT NULL DEFAULT 1 CHECK (shift_no IN (1, 2));
ALTER TABLE attendance DROP CONSTRAINT attendance_employee_id_date_key;
ALTER TABLE attendance ADD CONSTRAINT attendance_employee_date_shift_key UNIQUE (employee_id, date, shift_no);
