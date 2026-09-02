-- The flat total leave days HR has actually agreed with an employee (e.g.
-- "Raymond gets 20 days a year") — a bookkeeping figure only, so HR can
-- see it lines up as they split it across leave types via
-- employee_leave_entitlements. Never read by requestLeave()/rollover/etc:
-- each leave type still keeps its own independently-enforced balance:
-- this total is purely a reference number.
ALTER TABLE employees ADD COLUMN leave_days_total integer NULL;
