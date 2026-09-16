-- Dropping this loses which date an overnight clock-out fell on; those rows
-- revert to being read as same-day, which is what they were before.
ALTER TABLE attendance DROP CONSTRAINT attendance_clock_out_date_not_before;
ALTER TABLE attendance DROP COLUMN clock_out_date;
