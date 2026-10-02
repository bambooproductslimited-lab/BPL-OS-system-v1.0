DROP TABLE IF EXISTS leave_owed_settlements;
ALTER TABLE companies DROP COLUMN IF EXISTS leave_days_default;
ALTER TABLE leave_types DROP COLUMN IF EXISTS in_pool;
