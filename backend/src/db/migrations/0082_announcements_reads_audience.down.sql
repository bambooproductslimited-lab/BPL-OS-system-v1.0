DROP TABLE IF EXISTS announcement_reads;
DELETE FROM announcements WHERE audience_scope = 'company';
ALTER TABLE announcements DROP CONSTRAINT announcements_audience_scope_check;
ALTER TABLE announcements ADD CONSTRAINT announcements_audience_scope_check CHECK (audience_scope IN ('all', 'department'));
ALTER TABLE announcements
  DROP COLUMN IF EXISTS company_id,
  DROP COLUMN IF EXISTS category,
  DROP COLUMN IF EXISTS requires_ack,
  DROP COLUMN IF EXISTS expires_on,
  DROP COLUMN IF EXISTS updated_at;
