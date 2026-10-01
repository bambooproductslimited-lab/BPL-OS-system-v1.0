DELETE FROM employee_view_scopes WHERE company_id IS NOT NULL;
DROP INDEX uq_employee_view_scopes_company;
ALTER TABLE employee_view_scopes DROP CONSTRAINT employee_view_scopes_one_target;
ALTER TABLE employee_view_scopes DROP COLUMN company_id;
ALTER TABLE employee_view_scopes ADD CONSTRAINT employee_view_scopes_check CHECK ((department_id IS NULL) <> (employee_id IS NULL));
