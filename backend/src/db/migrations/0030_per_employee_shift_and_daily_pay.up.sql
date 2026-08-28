-- The OS now covers several businesses with genuinely different working
-- hours (via the TimeStation sync — factory, restaurant, security,
-- construction crew, etc.), so a single company-wide shift/lateness cutoff
-- (settings.late_after) no longer makes sense for everyone. shift_start/
-- shift_end are per-employee, optional (null = still follow the company
-- default exactly as before — see attendance.service.js's clockInEmployee).
ALTER TABLE employees ADD COLUMN shift_start time NULL;
ALTER TABLE employees ADD COLUMN shift_end   time NULL;

-- Adds a genuine daily pay cycle alongside monthly/biweekly, for staff paid
-- out per day worked rather than on a fixed period.
ALTER TABLE employees DROP CONSTRAINT employees_pay_cycle_check;
ALTER TABLE employees ADD CONSTRAINT employees_pay_cycle_check CHECK (pay_cycle IN ('monthly', 'biweekly', 'daily'));

ALTER TABLE pay_runs DROP CONSTRAINT pay_runs_cycle_check;
ALTER TABLE pay_runs ADD CONSTRAINT pay_runs_cycle_check CHECK (cycle IN ('monthly', 'biweekly', 'daily'));
