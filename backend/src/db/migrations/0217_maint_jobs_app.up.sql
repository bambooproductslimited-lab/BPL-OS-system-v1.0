-- The maintenance & IT team's phone app (My Jobs, frontend /myjobs;
-- maintenanceWorkOrders.service.js): a job is marked done only with a photo
-- of the finished work, kept with the work order (done_photos) or with the
-- routine's record of that time (maint_routine_log.photos). Each photo is
-- { key, type, at, by } (lib/fileStore.js).
ALTER TABLE maint_work_orders ADD COLUMN done_photos jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE maint_routine_log ADD COLUMN photos jsonb NOT NULL DEFAULT '[]'::jsonb;

-- A routine whose next day is close becomes a work order by itself
-- (jobs/maintRoutines.js). auto_made marks those, so the tracker can say so.
ALTER TABLE maint_work_orders ADD COLUMN auto_made boolean NOT NULL DEFAULT false;

-- The morning list: each person with jobs is told once a day what they have
-- (jobs/maintRoutines.js), however often the job runs or restarts.
CREATE TABLE maint_morning_sent (
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  day          date NOT NULL,
  jobs         integer NOT NULL DEFAULT 0,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, day)
);
