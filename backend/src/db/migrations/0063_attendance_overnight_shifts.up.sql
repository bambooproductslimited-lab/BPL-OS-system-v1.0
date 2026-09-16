-- A shift that runs past midnight needs a clock-out date of its own.
--
-- attendance carries one `date` and two bare times. That works for a day
-- shift, where both taps fall on the same date, and silently misrepresents a
-- night one. A guard starting 18:00 and finishing 06:00 taps twice on two
-- different dates, and the clock — which looked the row up by today's date —
-- found nothing to close and opened a second shift instead. Three nights
-- produced four rows, none of them describing a night: the row in the middle
-- read "in 06:00, out 18:05", which is the guard's rest period between two
-- shifts recorded as their shift.
--
-- The fix is in the pairing (a tap closes the employee's open shift rather
-- than today's row), and that needs somewhere to record which date the
-- clock-out landed on. NULL means the same day as `date`, so every existing
-- row keeps its current meaning and nothing has to be backfilled.
--
-- The shift itself is filed under the date it STARTED — the night of Tuesday
-- into Wednesday is Tuesday's shift — so `date` continues to mean what it
-- always did and payroll's day count needs no change.
ALTER TABLE attendance ADD COLUMN clock_out_date date NULL;

COMMENT ON COLUMN attendance.clock_out_date IS
  'Date the clock-out tap landed on. NULL means the same day as date, which is every day shift. Set only when a shift crosses midnight.';

-- A clock-out can only be on or after the day the shift opened.
ALTER TABLE attendance ADD CONSTRAINT attendance_clock_out_date_not_before
  CHECK (clock_out_date IS NULL OR clock_out_date >= date);
