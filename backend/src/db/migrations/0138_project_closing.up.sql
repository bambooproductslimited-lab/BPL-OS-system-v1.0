-- Closing projects (projects.service.js syncClosing, close): a project can
-- close itself once all its work orders are done — completed, or cancelled
-- with at least one completed — and reopen itself if one of them is opened
-- again or a new one is added; or be closed by hand, which can cancel the
-- work orders still open. New projects close themselves unless told not
-- to; projects already in the OS keep closing by hand until someone turns
-- it on, so none closes the moment this is deployed.
ALTER TABLE projects ADD COLUMN auto_close boolean NOT NULL DEFAULT false;
ALTER TABLE projects ALTER COLUMN auto_close SET DEFAULT true;
ALTER TABLE projects ADD COLUMN closed_at timestamptz NULL;
ALTER TABLE projects ADD COLUMN closed_by uuid NULL REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN closed_auto boolean NOT NULL DEFAULT false;
UPDATE projects SET closed_at = updated_at WHERE status IN ('completed', 'cancelled');
