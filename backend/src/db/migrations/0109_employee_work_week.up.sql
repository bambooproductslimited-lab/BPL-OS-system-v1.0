-- Each employee's work week: 'mon_fri', 'mon_sat' or 'all' (every day).
-- NULL keeps the usual rule (Monday to Saturday; at Bamboo Products'
-- Security, and outside Bamboo Products, attendance shows no rest day).
-- Used by payroll (a salaried person's working days), attendance (a rest
-- day shows as off, not absent) and leave (rest days aren't charged).
ALTER TABLE employees ADD COLUMN work_days text NULL CHECK (work_days IN ('mon_fri', 'mon_sat', 'all'));
