-- Maintenance and IT work orders: the jobs the maintenance team does around
-- our places (IT, electrical, plumbing, A/C, facilities, masonry), kept the
-- way the team kept them in its Google Sheet, the IT work order tracker
-- (maintenanceWorkOrders.service.js, maintenanceWoImport.service.js): who
-- asked and when, where, what kind of job, how urgent, who does it, the day
-- it is planned and the day it was done, what it cost, notes, and a tick
-- once the job has been checked for billing. Routines are the jobs that come
-- round again every so many days (A/C cleaning every 84 days), with the day
-- each was last done and the next one due.

CREATE TABLE maint_routines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref               text NOT NULL DEFAULT '',                -- RT-002, as on the sheet
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description       text NOT NULL DEFAULT '',
  location          text NOT NULL DEFAULT '',
  company_id        uuid NULL REFERENCES companies(id) ON DELETE SET NULL,
  category          text NOT NULL DEFAULT 'other'
                    CHECK (category IN ('electrical', 'plumbing', 'hvac', 'facilities', 'it', 'mason', 'other')),
  schedule_note     text NOT NULL DEFAULT '',                -- "Wed. morning"
  assigned_to_id    uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  assigned_to_name  text NOT NULL DEFAULT '',                -- as written, when not matched to anyone
  every_days        integer NULL CHECK (every_days IS NULL OR every_days BETWEEN 1 AND 3660),
  last_done_on      date NULL,
  next_on           date NULL,                               -- last done + every so many days, or set by hand
  notes             text NOT NULL DEFAULT '',
  link              text NOT NULL DEFAULT '',
  archived_at       timestamptz NULL,
  sheet_key         text NULL UNIQUE,                        -- a row brought in from the sheet
  sheet_synced_at   timestamptz NULL,                        -- when the sheet last brought it up to date
  created_by        uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_maint_routines_next ON maint_routines(next_on) WHERE archived_at IS NULL;

CREATE TABLE maint_work_orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref                text NOT NULL DEFAULT '',               -- WO-1001: the sheet's number, then the next one
  requested_on       date NOT NULL DEFAULT current_date,
  requested_by_id    uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  requested_by_name  text NOT NULL DEFAULT '',
  location           text NOT NULL DEFAULT '',
  company_id         uuid NULL REFERENCES companies(id) ON DELETE SET NULL,  -- whose place it is, when known
  category           text NOT NULL DEFAULT 'other'
                     CHECK (category IN ('electrical', 'plumbing', 'hvac', 'facilities', 'it', 'mason', 'other')),
  description        text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  priority           text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  status             text NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new', 'scheduled', 'in_progress', 'on_hold', 'completed', 'cancelled')),
  assigned_to_id     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  assigned_to_name   text NOT NULL DEFAULT '',
  scheduled_on       date NULL,
  completed_on       date NULL,
  currency           text NOT NULL DEFAULT 'GHS' CHECK (currency ~ '^[A-Z]{3}$'),
  estimated_cost     numeric(12,2) NULL CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
  actual_cost        numeric(12,2) NULL CHECK (actual_cost IS NULL OR actual_cost >= 0),
  notes              text NOT NULL DEFAULT '',
  audited_at         timestamptz NULL,
  audited_by         uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  routine_id         uuid NULL REFERENCES maint_routines(id) ON DELETE SET NULL,
  sheet_key          text NULL UNIQUE,
  sheet_synced_at    timestamptz NULL,                       -- when the sheet last brought it up to date
  created_by         uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'completed' OR completed_on IS NOT NULL)
);
CREATE INDEX idx_maint_wo_status ON maint_work_orders(status);
CREATE INDEX idx_maint_wo_requested ON maint_work_orders(requested_on DESC);
CREATE INDEX idx_maint_wo_assigned ON maint_work_orders(assigned_to_id);
CREATE INDEX idx_maint_wo_requester ON maint_work_orders(requested_by_id);
CREATE INDEX idx_maint_wo_routine ON maint_work_orders(routine_id);

-- Each time a routine was done, by whom, and the work order it was, if any.
CREATE TABLE maint_routine_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_id     uuid NOT NULL REFERENCES maint_routines(id) ON DELETE CASCADE,
  done_on        date NOT NULL,
  done_by_id     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  note           text NOT NULL DEFAULT '',
  work_order_id  uuid NULL REFERENCES maint_work_orders(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_maint_routine_log ON maint_routine_log(routine_id, done_on DESC);
