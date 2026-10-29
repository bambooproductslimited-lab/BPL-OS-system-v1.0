DELETE FROM sms_messages WHERE status = 'skipped';
ALTER TABLE sms_messages DROP CONSTRAINT IF EXISTS sms_messages_status_check;
ALTER TABLE sms_messages ADD CONSTRAINT sms_messages_status_check CHECK (status IN ('sent', 'failed'));
ALTER TABLE employees DROP COLUMN IF EXISTS sms_opt_out;
ALTER TABLE crm_leads DROP COLUMN IF EXISTS no_follow_up_reason, DROP COLUMN IF EXISTS no_follow_up_by, DROP COLUMN IF EXISTS no_follow_up_at;
ALTER TABLE customers DROP COLUMN IF EXISTS no_follow_up_reason, DROP COLUMN IF EXISTS no_follow_up_by, DROP COLUMN IF EXISTS no_follow_up_at;
UPDATE customers SET category = 'lead' WHERE category = 'contact';
ALTER TABLE customers DROP COLUMN IF EXISTS contact_reason;
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_category_check;
ALTER TABLE customers ADD CONSTRAINT customers_category_check CHECK (category IN ('lead', 'prospect', 'active', 'inactive', 'vip'));
UPDATE crm_leads SET stage = 'lost' WHERE stage = 'not_lead';
ALTER TABLE crm_leads DROP CONSTRAINT IF EXISTS crm_leads_stage_check;
ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_stage_check
  CHECK (stage IN ('new', 'contacted', 'follow_up', 'qualified', 'quote_sent', 'negotiation', 'won', 'lost'));
