-- Automatic clock-out for a shift nobody clocked out of.
--
-- Until now an open shift stayed open until the next tap, which closed it —
-- so an employee who forgot to tap out on Monday closed Monday's shift when
-- they arrived on Tuesday, recorded as a 24-hour shift, and had to tap twice
-- to start Tuesday's. The business rule is now that a shift left open is
-- clocked out automatically 11 hours after it started (see
-- attendance.service.js's closeOverdueShifts), and the employee is told the
-- next time they clock in.
--
-- auto_clocked_out marks the clock-out as the system's, not a tap, so the
-- attendance screens can show it and a supervisor knows which times to
-- check. It is cleared whenever a real time replaces it (a supervisor's
-- correction, a TimeStation sync, or a delayed kiosk tap from the offline
-- queue that turns out to be the real clock-out).
--
-- auto_clock_out_seen_at records when the employee was shown the notice, so
-- they are told once, at their next clock-in, and not every time after.
ALTER TABLE attendance ADD COLUMN auto_clocked_out boolean NOT NULL DEFAULT false;
ALTER TABLE attendance ADD COLUMN auto_clock_out_seen_at timestamptz NULL;

-- The sweep looks for open shifts; the notice looks for unseen automatic
-- clock-outs per employee. Both are small sets, kept small by these.
CREATE INDEX idx_attendance_open_shifts ON attendance (employee_id) WHERE clock_in IS NOT NULL AND clock_out IS NULL;
CREATE INDEX idx_attendance_auto_unseen ON attendance (employee_id) WHERE auto_clocked_out AND auto_clock_out_seen_at IS NULL;
