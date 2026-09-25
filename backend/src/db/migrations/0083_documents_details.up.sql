-- Documents: which company one belongs to (none = the whole group), a short
-- description, the file's size and type, which version of the file this is
-- (renewing a licence uploads a new version over the old one) and when it
-- was last changed (documents.service.js).
ALTER TABLE documents
  ADD COLUMN company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  ADD COLUMN description text NOT NULL DEFAULT '',
  ADD COLUMN size integer,
  ADD COLUMN content_type text,
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN updated_at timestamptz;
