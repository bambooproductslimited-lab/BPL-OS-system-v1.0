-- Persistent link from a Bamboo OS employee back to their TimeStation
-- employee_id. Needed for the planned attendance sync: matching clock
-- events back to the right person by name/email each time would be
-- fragile (mutable, and many TimeStation records have no email at all —
-- see timestation.service.js). Nullable — only ever set for employees that
-- came from (or were matched against) the TimeStation sync.
ALTER TABLE employees ADD COLUMN timestation_employee_id text NULL;
CREATE UNIQUE INDEX idx_employees_timestation_employee_id ON employees(timestation_employee_id) WHERE timestation_employee_id IS NOT NULL;
