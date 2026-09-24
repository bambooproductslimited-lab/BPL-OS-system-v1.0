-- How many minutes after an employee's shift start they are still on time
-- (attendance.service.js). It was a fixed 20 in code; it is now 10, and
-- can be changed in Company settings.
--
-- Kept by date rather than as one number, because the lateness report works
-- out every past day again from the clock-in time: with a single number,
-- changing it would quietly re-judge months of attendance under a rule that
-- didn't apply then. Each day is judged by the grace in force on that day.
CREATE TABLE late_grace (
  effective_from  date PRIMARY KEY,
  minutes         integer NOT NULL CHECK (minutes BETWEEN 0 AND 240),
  set_by          uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  set_at          timestamptz NOT NULL DEFAULT now()
);
INSERT INTO late_grace (effective_from, minutes) VALUES ('2000-01-01', 20), (CURRENT_DATE, 10)
ON CONFLICT (effective_from) DO UPDATE SET minutes = EXCLUDED.minutes;

-- Staff with no shift are judged against one company-wide time, which was
-- the 07:00 day shift plus the old 20 minutes. Move it with the grace,
-- unless someone has already set it to something else.
UPDATE settings SET late_after = '07:10' WHERE late_after = '07:20';
