-- Two switches per person for My Jobs, turned on by a work order manager in
-- the tracker (maintenanceWorkOrders.service.js setMyJobsRight):
--   every_job  sees every maintenance & IT job (the Team tab) and works on
--              any of them: starts it, puts it on hold, adds notes, marks it
--              done with its photo;
--   give_out   also adds jobs and routines for others and sees what they
--              gave out — as the managers and supervisors do, in My Jobs only.
CREATE TABLE myjobs_rights (
  employee_id  uuid PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  every_job    boolean NOT NULL DEFAULT false,
  give_out     boolean NOT NULL DEFAULT false,
  granted_by   uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
