UPDATE permissions SET label = 'View tasks' WHERE key = 'task.read';
UPDATE permissions SET label = 'Create & assign tasks' WHERE key = 'task.manage';
UPDATE tasks SET status = 'not_started' WHERE status = 'discussing';
UPDATE tasks SET status = 'waiting' WHERE status = 'awaiting_material';
ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('not_started', 'in_progress', 'waiting', 'under_review', 'completed', 'cancelled'));
DROP INDEX IF EXISTS idx_tasks_project_manager;
DROP INDEX IF EXISTS idx_tasks_sheet_stamp;
ALTER TABLE tasks
  DROP COLUMN sheet_stamp, DROP COLUMN work_days, DROP COLUMN workers, DROP COLUMN cancelled_at, DROP COLUMN issued_on,
  DROP COLUMN prepared_by_name, DROP COLUMN team_names, DROP COLUMN pm_name, DROP COLUMN project_manager_id,
  DROP COLUMN process, DROP COLUMN material_spec, DROP COLUMN material_quantity, DROP COLUMN materials,
  DROP COLUMN specification, DROP COLUMN quantity, DROP COLUMN item_code,
  DROP COLUMN so_ref, DROP COLUMN contact, DROP COLUMN customer_name, DROP COLUMN customer_id, DROP COLUMN for_company_id,
  DROP COLUMN wo_no;
