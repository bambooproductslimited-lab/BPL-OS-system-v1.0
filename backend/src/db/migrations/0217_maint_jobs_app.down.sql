DROP TABLE IF EXISTS maint_morning_sent;
ALTER TABLE maint_work_orders DROP COLUMN IF EXISTS auto_made;
ALTER TABLE maint_routine_log DROP COLUMN IF EXISTS photos;
ALTER TABLE maint_work_orders DROP COLUMN IF EXISTS done_photos;
