-- Tasks become work orders (WOs), recorded the way the workshop has kept
-- them in its Google Form and sheet: what is asked for and for whom, the
-- item, quantity, specification, materials and process, a project manager
-- over the team, the date issued and the estimated date due, and how long
-- it took (tasks.service.js, workOrderImport.service.js).

-- 1. A number for each WO (WO-0001), oldest first.
CREATE SEQUENCE tasks_wo_no_seq;
ALTER TABLE tasks ADD COLUMN wo_no integer NULL;
UPDATE tasks t SET wo_no = x.n FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM tasks) x WHERE x.id = t.id;
SELECT setval('tasks_wo_no_seq', coalesce((SELECT max(wo_no) FROM tasks), 0) + 1, false);
ALTER TABLE tasks ALTER COLUMN wo_no SET DEFAULT nextval('tasks_wo_no_seq');
ALTER TABLE tasks ALTER COLUMN wo_no SET NOT NULL;
ALTER TABLE tasks ADD CONSTRAINT tasks_wo_no_key UNIQUE (wo_no) DEFERRABLE INITIALLY IMMEDIATE;
ALTER SEQUENCE tasks_wo_no_seq OWNED BY tasks.wo_no;

-- 2. Who it is for: one of our own companies (BPL, Poki, Star Bar, Bamboo
--    Garden…), a customer, or just a name as written on the sheet.
ALTER TABLE tasks ADD COLUMN for_company_id uuid NULL REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN customer_id uuid NULL REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN customer_name text NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN contact text NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN so_ref text NOT NULL DEFAULT '';          -- sales order number, linked when it exists

-- 3. What is to be made or done.
ALTER TABLE tasks ADD COLUMN item_code text NOT NULL DEFAULT '';       -- catalogue code(s) (H51, V51 …)
ALTER TABLE tasks ADD COLUMN quantity text NOT NULL DEFAULT '';        -- as written: "2", "1,1", "18 bundles"
ALTER TABLE tasks ADD COLUMN specification text NOT NULL DEFAULT '';   -- sizes, or a link
ALTER TABLE tasks ADD COLUMN materials text NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN material_quantity text NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN material_spec text NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN process text NOT NULL DEFAULT '';         -- "cut to size, assemble and polish"

-- 4. Who: a project manager over the team (task_assignees); names from the
--    sheet that are not (yet) matched to a staff member are kept as written.
ALTER TABLE tasks ADD COLUMN project_manager_id uuid NULL REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN pm_name text NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN team_names text NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN prepared_by_name text NOT NULL DEFAULT '';

-- 5. When, and how much work it took.
ALTER TABLE tasks ADD COLUMN issued_on date NULL;
UPDATE tasks SET issued_on = (created_at AT TIME ZONE 'UTC')::date;
ALTER TABLE tasks ADD COLUMN cancelled_at timestamptz NULL;
ALTER TABLE tasks ADD COLUMN workers integer NULL CHECK (workers IS NULL OR workers BETWEEN 0 AND 500);
ALTER TABLE tasks ADD COLUMN work_days numeric(7,1) NULL CHECK (work_days IS NULL OR work_days >= 0);

-- 6. Rows brought in from the sheet carry the form's timestamp, so the
--    same row is never imported twice.
ALTER TABLE tasks ADD COLUMN sheet_stamp timestamptz NULL;
CREATE INDEX idx_tasks_sheet_stamp ON tasks(sheet_stamp) WHERE sheet_stamp IS NOT NULL;
CREATE INDEX idx_tasks_project_manager ON tasks(project_manager_id);

-- 7. The sheet's statuses: Discussing (and Awaiting WO) before a WO is
--    issued, and Awaiting material while work waits for it.
ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('discussing', 'not_started', 'in_progress', 'awaiting_material', 'waiting', 'under_review', 'completed', 'cancelled'));

-- 8. The permissions read as work orders.
UPDATE permissions SET label = 'View work orders' WHERE key = 'task.read';
UPDATE permissions SET label = 'Create & assign work orders' WHERE key = 'task.manage';
