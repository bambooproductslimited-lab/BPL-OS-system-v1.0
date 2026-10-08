-- Who a project is for, as on a work order (migration 0136): one of our
-- companies, a customer, or a name. A work order issued for the project
-- starts with it filled in (WorkOrdersPage.jsx), along with the project's
-- owner as project manager and its members as the team.
ALTER TABLE projects ADD COLUMN for_company_id uuid NULL REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN customer_id uuid NULL REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN customer_name text NOT NULL DEFAULT '';
