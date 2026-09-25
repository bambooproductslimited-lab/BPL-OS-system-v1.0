-- When a task was marked completed, so the tasks page can say "done this
-- week" and show when each finished task was done. Cleared again if the
-- task is reopened (tasks.service.js#setStatus). Existing completed tasks
-- have no record of when; they stay NULL.
ALTER TABLE tasks ADD COLUMN completed_at timestamptz;
