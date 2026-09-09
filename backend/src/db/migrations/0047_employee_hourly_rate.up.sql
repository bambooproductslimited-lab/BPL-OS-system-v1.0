-- Hourly rate per employee, used by the TimeStation-style attendance
-- report (Total Pay = Total Hours x Hourly Rate) — separate from the
-- daily_rate already used in real pay runs (payroll.service.js). Nullable:
-- most employees don't have one until HR sets it, and the report treats a
-- missing rate as simply blank/zero pay rather than a hard requirement.
ALTER TABLE employees ADD COLUMN hourly_rate numeric(10,2) NULL;
