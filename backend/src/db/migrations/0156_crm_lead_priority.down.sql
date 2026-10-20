DELETE FROM crm_lead_notes WHERE kind = 'priority';
ALTER TABLE crm_lead_notes DROP CONSTRAINT crm_lead_notes_kind_check;
ALTER TABLE crm_lead_notes ADD CONSTRAINT crm_lead_notes_kind_check CHECK (kind IN ('note', 'call', 'stage', 'visit', 'deal'));
DROP INDEX IF EXISTS idx_crm_leads_manual_priority;
ALTER TABLE crm_leads DROP COLUMN IF EXISTS priority_at, DROP COLUMN IF EXISTS priority_by, DROP COLUMN IF EXISTS manual_priority;
