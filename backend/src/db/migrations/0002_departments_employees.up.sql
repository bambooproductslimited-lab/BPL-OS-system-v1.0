-- kernel.js seed(): db.departments, db.employees

CREATE TABLE departments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  manager_id  uuid NULL, -- FK to employees added below (deferred: departments and
                          -- employees reference each other)
  parent_id   uuid NULL REFERENCES departments(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE employees (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE, -- e.g. 'BPL-001'
  first_name       text NOT NULL,
  last_name        text NOT NULL,
  email            text NOT NULL UNIQUE,
  phone            text NOT NULL DEFAULT '',
  department_id    uuid NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  position_title   text NOT NULL DEFAULT '',
  manager_id       uuid NULL REFERENCES employees(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  employment_type  text NOT NULL DEFAULT 'permanent' CHECK (employment_type IN ('permanent', 'contract', 'temporary', 'intern')),
  hire_date        date NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'terminated')),
  location         text NOT NULL DEFAULT '',
  shift            text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE departments
  ADD CONSTRAINT departments_manager_id_fkey
  FOREIGN KEY (manager_id) REFERENCES employees(id) ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX idx_employees_department_id ON employees(department_id);
CREATE INDEX idx_employees_manager_id ON employees(manager_id);
CREATE INDEX idx_departments_manager_id ON departments(manager_id);
