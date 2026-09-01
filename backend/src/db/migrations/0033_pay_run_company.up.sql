-- A pay run can now optionally be scoped to one company (the tier added in
-- migration 0032) instead of always spanning every active employee on its
-- cycle across all companies. NULL means "all companies" — the only
-- behavior that existed before this column, so every existing pay run
-- stays exactly as it was.
ALTER TABLE pay_runs ADD COLUMN company_id uuid NULL REFERENCES companies(id) ON DELETE RESTRICT;
CREATE INDEX idx_pay_runs_company_id ON pay_runs(company_id);
