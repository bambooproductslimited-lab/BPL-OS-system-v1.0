ALTER TABLE maint_routines DROP COLUMN IF EXISTS place_link, DROP COLUMN IF EXISTS place_lng, DROP COLUMN IF EXISTS place_lat;
ALTER TABLE maint_work_orders DROP COLUMN IF EXISTS place_link, DROP COLUMN IF EXISTS place_lng, DROP COLUMN IF EXISTS place_lat;
DELETE FROM role_permissions WHERE permission_key = 'task.manage' AND role_id = (SELECT id FROM roles WHERE key = 'executive');
