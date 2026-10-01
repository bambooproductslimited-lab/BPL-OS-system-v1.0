-- Who can see whom, by company (viewScope.service.js). A ticked company
-- means everyone in it. For a role that sees everyone (employee.read.all),
-- ticking companies narrows "everyone" to those companies; none ticked is
-- every company, as before.
ALTER TABLE employee_view_scopes ADD COLUMN company_id uuid NULL REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE employee_view_scopes DROP CONSTRAINT employee_view_scopes_check;
ALTER TABLE employee_view_scopes ADD CONSTRAINT employee_view_scopes_one_target
  CHECK ((department_id IS NOT NULL)::int + (employee_id IS NOT NULL)::int + (company_id IS NOT NULL)::int = 1);
CREATE UNIQUE INDEX uq_employee_view_scopes_company ON employee_view_scopes (viewer_id, company_id) WHERE company_id IS NOT NULL;
