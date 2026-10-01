-- Which employees a manager can see (directory, attendance, leave — every
-- screen that asks rbac.visibleEmployee). Roles that see everyone
-- (employee.read.all: administrator, executive, HR, Finance & HR, general
-- manager) are unaffected. Anyone else sees themselves, the people who
-- report to them (managers), and whatever departments and people HR ticks
-- here for them — nothing else.
CREATE TABLE employee_view_scopes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  viewer_id      uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  department_id  uuid NULL REFERENCES departments(id) ON DELETE CASCADE,
  employee_id    uuid NULL REFERENCES employees(id) ON DELETE CASCADE,
  created_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((department_id IS NULL) <> (employee_id IS NULL))
);
CREATE UNIQUE INDEX uq_employee_view_scopes_dept ON employee_view_scopes (viewer_id, department_id) WHERE department_id IS NOT NULL;
CREATE UNIQUE INDEX uq_employee_view_scopes_emp ON employee_view_scopes (viewer_id, employee_id) WHERE employee_id IS NOT NULL;

-- Until now a manager saw their whole own department. Keep that on the day
-- this ships, as a ticked department HR can now take away, so nobody loses
-- sight of anyone before HR has decided. (Same statement in seed.js.)
INSERT INTO employee_view_scopes (viewer_id, department_id)
SELECT DISTINCT e.id, e.department_id
FROM employees e JOIN users u ON u.employee_id = e.id
WHERE e.department_id IS NOT NULL AND e.status <> 'terminated'
  AND EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
              WHERE ur.user_id = u.id AND rp.permission_key IN ('attendance.read.all', 'leave.read.all', 'task.manage'))
  AND NOT EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
                  WHERE ur.user_id = u.id AND rp.permission_key = 'employee.read.all')
ON CONFLICT DO NOTHING;
