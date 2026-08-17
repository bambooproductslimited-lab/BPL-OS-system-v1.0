-- kernel.js: db.tasks, db.projects, db.announcements, db.documents, db.messages
-- Not yet wired to routes in this pass (auth + leave is the current PoC scope) —
-- tables are created now so the schema matches the full data model up front.

CREATE TABLE projects (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,
  name           text NOT NULL,
  department_id  uuid NULL REFERENCES departments(id) ON DELETE SET NULL,
  owner_id       uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  start_date     date NULL,
  deadline       date NULL,
  status         text NOT NULL DEFAULT 'planning' CHECK (status IN ('planning', 'active', 'on_hold', 'completed', 'cancelled')),
  budget         numeric(14,2) NULL,
  description    text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_members (
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, employee_id)
);

CREATE TABLE tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  project_id   uuid NULL REFERENCES projects(id) ON DELETE SET NULL,
  priority     text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  due_date     date NULL,
  status       text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'under_review', 'done')),
  created_by   uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  description  text NOT NULL DEFAULT ''
);

CREATE TABLE task_assignees (
  task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, employee_id)
);

CREATE TABLE task_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  text       text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE announcements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title            text NOT NULL,
  body             text NOT NULL,
  audience_scope   text NOT NULL DEFAULT 'all' CHECK (audience_scope IN ('all', 'department')),
  department_id    uuid NULL REFERENCES departments(id) ON DELETE SET NULL,
  published_by     uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  published_at     timestamptz NOT NULL DEFAULT now(),
  pinned           boolean NOT NULL DEFAULT false
);

CREATE TABLE documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title          text NOT NULL,
  category       text NOT NULL DEFAULT '',
  department_id  uuid NULL REFERENCES departments(id) ON DELETE SET NULL,
  visibility     text NOT NULL DEFAULT 'all' CHECK (visibility IN ('all', 'managers', 'department')),
  uploaded_by    uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  file_name      text NOT NULL,
  object_key     text NULL -- S3-compatible object storage key, once real uploads are wired up
);

CREATE TABLE messages (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  to_id    uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  body     text NOT NULL,
  at       timestamptz NOT NULL DEFAULT now(),
  read     boolean NOT NULL DEFAULT false
);

CREATE INDEX idx_tasks_project_id ON tasks(project_id);
CREATE INDEX idx_task_comments_task_id ON task_comments(task_id);
CREATE INDEX idx_documents_department_id ON documents(department_id);
CREATE INDEX idx_messages_from_to ON messages(from_id, to_id);
CREATE INDEX idx_messages_to_read ON messages(to_id, read);
