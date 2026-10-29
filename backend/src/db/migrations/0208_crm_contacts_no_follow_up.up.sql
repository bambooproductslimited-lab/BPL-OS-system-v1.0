-- Not everyone who writes to us is a lead, a prospect or a customer: a
-- supplier, a job seeker, staff or family, a wrong number. And some people
-- should not be followed up any more. crm.service.js, crmProfiles.service.js.
--
-- 1. A lead that isn't one: its own stage, not_lead — out of the pipeline
--    and its counts, and not "lost" (it never was a sale to lose). The
--    reason goes in lost_reason, as a lost lead's does.
ALTER TABLE crm_leads DROP CONSTRAINT IF EXISTS crm_leads_stage_check;
ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_stage_check
  CHECK (stage IN ('new', 'contacted', 'follow_up', 'qualified', 'quote_sent', 'negotiation', 'won', 'lost', 'not_lead'));

-- 2. A profile that is just a contact: category contact, with who they are.
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_category_check;
ALTER TABLE customers ADD CONSTRAINT customers_category_check
  CHECK (category IN ('lead', 'prospect', 'active', 'inactive', 'vip', 'contact'));
ALTER TABLE customers ADD COLUMN IF NOT EXISTS contact_reason text NOT NULL DEFAULT '';

-- 3. "Don't follow up": on a profile (the person) or one lead; who said so,
--    when and why. Nothing reminds anyone to chase them while it is set.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS no_follow_up_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS no_follow_up_by uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS no_follow_up_reason text NOT NULL DEFAULT '';
ALTER TABLE crm_leads
  ADD COLUMN IF NOT EXISTS no_follow_up_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS no_follow_up_by uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS no_follow_up_reason text NOT NULL DEFAULT '';

-- 4. Staff who never get texts from the OS (sms.service.js): the CEO, say.
--    A text that would have gone to their phone is kept in the log as
--    skipped. Sign-in codes they ask for themselves still go.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS sms_opt_out boolean NOT NULL DEFAULT false;
ALTER TABLE sms_messages DROP CONSTRAINT IF EXISTS sms_messages_status_check;
ALTER TABLE sms_messages ADD CONSTRAINT sms_messages_status_check CHECK (status IN ('sent', 'failed', 'skipped'));
