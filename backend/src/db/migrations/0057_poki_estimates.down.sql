DROP INDEX IF EXISTS idx_poki_leases_from_estimate;
ALTER TABLE poki_leases DROP COLUMN IF EXISTS from_estimate_id;

DROP INDEX IF EXISTS idx_estimates_doc_kind;
DROP INDEX IF EXISTS idx_estimates_poki_unit;
ALTER TABLE estimates DROP COLUMN IF EXISTS poki_unit_id;
ALTER TABLE estimates DROP COLUMN IF EXISTS doc_kind;
