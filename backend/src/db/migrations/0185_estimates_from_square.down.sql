DROP INDEX IF EXISTS ux_estimates_external_id;
ALTER TABLE estimates DROP COLUMN IF EXISTS source;
ALTER TABLE estimates DROP COLUMN IF EXISTS external_id;
