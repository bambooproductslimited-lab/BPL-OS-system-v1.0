-- kernel.js: PERMISSIONS catalogue, seed() roles, seed() users
-- Ported 1:1 from the kernel's RBAC model: roles hold permissions (role_permissions),
-- users hold roles (user_roles) — no direct user -> permission grants, matching
-- PROJECT_NOTES.md's "Permissions are resource.action strings; roles hold a
-- permissions: string[] array — users get roles, roles get permissions."

CREATE TABLE permissions (
  key    text PRIMARY KEY, -- e.g. 'leave.approve'
  "group" text NOT NULL,
  label  text NOT NULL
);

CREATE TABLE roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text NOT NULL UNIQUE, -- e.g. 'department_manager'
  name         text NOT NULL,
  is_system    boolean NOT NULL DEFAULT true,
  description  text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
  role_id         uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key  text NOT NULL REFERENCES permissions(key) ON DELETE RESTRICT,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id           uuid NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
  email                 text NOT NULL UNIQUE,
  password_hash         text NOT NULL, -- bcrypt hash (see src/services/auth.service.js)
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_login_at         timestamptz NULL,
  must_change_password  boolean NOT NULL DEFAULT false,
  failed_login_attempts integer NOT NULL DEFAULT 0,
  locked_until          timestamptz NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_roles (
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id  uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_user_roles_user_id ON user_roles(user_id);
CREATE INDEX idx_role_permissions_role_id ON role_permissions(role_id);
