-- Announcements: who has read (and, when asked, confirmed) each one; a
-- whole company as an audience besides everyone or one department; a
-- category; an optional date after which it stops showing; and when it was
-- last edited (announcements.service.js).
CREATE TABLE announcement_reads (
  announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  PRIMARY KEY (announcement_id, employee_id)
);
CREATE INDEX announcement_reads_employee_idx ON announcement_reads (employee_id);

ALTER TABLE announcements DROP CONSTRAINT announcements_audience_scope_check;
ALTER TABLE announcements ADD CONSTRAINT announcements_audience_scope_check CHECK (audience_scope IN ('all', 'company', 'department'));
ALTER TABLE announcements
  ADD COLUMN company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  ADD COLUMN category text NOT NULL DEFAULT 'general' CHECK (category IN ('general', 'policy', 'event', 'safety', 'celebration')),
  ADD COLUMN requires_ack boolean NOT NULL DEFAULT false,
  ADD COLUMN expires_on date,
  ADD COLUMN updated_at timestamptz;

-- The publisher has seen their own announcements.
INSERT INTO announcement_reads (announcement_id, employee_id, read_at)
SELECT id, published_by, published_at FROM announcements ON CONFLICT DO NOTHING;
