-- ID/passport document uploads on an employee record (front of ID, back
-- of ID, passport scan) — three fixed slots per employee, each holding at
-- most one current file (re-uploading replaces it). Real file storage via
-- the same Cloudflare R2 setup Documents uses (backend/src/lib/storage.js).

CREATE TABLE employee_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('id_front', 'id_back', 'passport')),
  file_name    text NOT NULL,
  object_key   text NOT NULL,
  uploaded_by  uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, kind)
);

CREATE INDEX idx_employee_documents_employee_id ON employee_documents(employee_id);
