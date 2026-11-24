-- 1. The MD gives out maintenance & IT jobs and routines too: the Executive
--    (MD) role may create and assign work orders (task.manage), as the
--    managers and supervisors may (db/referenceData.js).
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'task.manage' FROM roles r WHERE r.key = 'executive'
ON CONFLICT DO NOTHING;

-- 2. Where a job or routine is, on the map (maintenanceWorkOrders.service.js):
--    the phone's GPS position when it was added, or a Google Maps link
--    pasted in (its coordinates read from it where the link has them).
--    A routine's place goes with each work order it becomes.
ALTER TABLE maint_work_orders
  ADD COLUMN place_lat double precision NULL CHECK (place_lat BETWEEN -90 AND 90),
  ADD COLUMN place_lng double precision NULL CHECK (place_lng BETWEEN -180 AND 180),
  ADD COLUMN place_link text NOT NULL DEFAULT '';
ALTER TABLE maint_routines
  ADD COLUMN place_lat double precision NULL CHECK (place_lat BETWEEN -90 AND 90),
  ADD COLUMN place_lng double precision NULL CHECK (place_lng BETWEEN -180 AND 180),
  ADD COLUMN place_link text NOT NULL DEFAULT '';
