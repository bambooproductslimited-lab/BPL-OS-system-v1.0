DROP INDEX IF EXISTS ux_marketing_requests_routine_on;
ALTER TABLE marketing_requests DROP COLUMN IF EXISTS routine_on;
ALTER TABLE marketing_requests DROP COLUMN IF EXISTS routine_id;
DROP TABLE IF EXISTS marketing_request_routines;
