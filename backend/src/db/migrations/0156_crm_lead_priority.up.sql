-- A lead's priority (services/crmLeadPriority.service.js): worked out from
-- what is known about the lead, unless someone on the team marks it
-- Important (always near the top) or Low priority (always near the bottom).
-- Who did it and when are kept, and the change goes in the lead's history
-- (a crm_lead_notes row of kind 'priority' whose body is high, low or auto).
ALTER TABLE crm_leads
  ADD COLUMN manual_priority text NULL CHECK (manual_priority IN ('high', 'low')),
  ADD COLUMN priority_by uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  ADD COLUMN priority_at timestamptz NULL;
CREATE INDEX idx_crm_leads_manual_priority ON crm_leads (manual_priority) WHERE manual_priority IS NOT NULL;

ALTER TABLE crm_lead_notes DROP CONSTRAINT crm_lead_notes_kind_check;
ALTER TABLE crm_lead_notes ADD CONSTRAINT crm_lead_notes_kind_check CHECK (kind IN ('note', 'call', 'stage', 'visit', 'deal', 'priority'));
