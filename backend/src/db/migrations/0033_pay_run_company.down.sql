DROP INDEX IF EXISTS idx_pay_runs_company_id;
ALTER TABLE pay_runs DROP COLUMN IF EXISTS company_id;
