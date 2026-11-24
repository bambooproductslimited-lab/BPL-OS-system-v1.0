-- Photos taken when a maintenance & IT job or routine is added (My Jobs,
-- maintenanceWorkOrders.service.js): what the problem looks like — the
-- leaking tap, the broken socket — or, for a routine, what is looked after
-- and how. Kept apart from the photos of the finished work (done_photos).
-- Each photo is { key, type, at, by } (lib/fileStore.js). A routine's photos
-- go with each work order it becomes.
ALTER TABLE maint_work_orders ADD COLUMN photos jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE maint_routines ADD COLUMN photos jsonb NOT NULL DEFAULT '[]'::jsonb;
