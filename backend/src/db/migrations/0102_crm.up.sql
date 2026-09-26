-- The CRM (services/crm.service.js): the sales team's leads, from the first
-- message to a won or lost deal, replacing the "Kick-back CRM" and
-- "Customer Leads" spreadsheets.
--
--   crm_leads        one enquiry: who, how they found us (source), what
--                    they want, the stage it has reached, the rep on it and
--                    the next follow-up
--   crm_lead_notes   its history: notes, calls and every stage change
--   crm_deals        a won lead's sale — an OS invoice — with the rep's
--                    commission or kick-back. The money (value, discount,
--                    paid, balance) is always read from the invoice, never
--                    copied here, so it can't disagree with Finance
--   crm_referrals    someone outside who sent a customer, and their share
--   crm_prospects    people and companies to approach: fair and event
--                    contacts, industry lists
--   crm_site_visits  visits to measure or assess a job, and who went
--   crm_settings     the commission base rate (a discount given comes off
--                    it), the referral rate, and which company's invoices
--                    count as CRM sales

CREATE TABLE crm_settings (
  id               integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  commission_rate  numeric(5,2) NOT NULL DEFAULT 20 CHECK (commission_rate >= 0 AND commission_rate <= 100),
  referral_rate    numeric(5,2) NOT NULL DEFAULT 20 CHECK (referral_rate >= 0 AND referral_rate <= 100),
  company_id       uuid NULL REFERENCES companies(id) ON DELETE SET NULL,
  sources          jsonb NOT NULL DEFAULT '["WhatsApp", "Phone call", "Walk-in", "Referral", "Instagram", "Facebook", "TikTok", "Website", "Fair or event"]',
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid NULL REFERENCES employees(id) ON DELETE SET NULL
);
INSERT INTO crm_settings (id, company_id) VALUES (1, (SELECT id FROM companies WHERE code = 'BPL' LIMIT 1));

CREATE TABLE crm_prospects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_name     text NOT NULL DEFAULT '',          -- the fair, event or list it came from
  market        text NOT NULL DEFAULT 'local' CHECK (market IN ('local', 'export')),
  company       text NOT NULL DEFAULT '',
  name          text NOT NULL DEFAULT '',
  phone         text NOT NULL DEFAULT '',
  email         text NOT NULL DEFAULT '',
  website       text NOT NULL DEFAULT '',
  interest      text NOT NULL DEFAULT '',
  notes         text NOT NULL DEFAULT '',
  external_key  text NULL UNIQUE,                  -- set by the spreadsheet import
  created_by    uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (company <> '' OR name <> '')
);
CREATE INDEX idx_crm_prospects_list ON crm_prospects (list_name);

CREATE SEQUENCE crm_lead_ref_seq;
CREATE TABLE crm_leads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref               text NOT NULL UNIQUE DEFAULT ('L-' || lpad(nextval('crm_lead_ref_seq')::text, 4, '0')),
  sheet_ref         text NOT NULL DEFAULT '',      -- the Lead ID it had in the spreadsheet
  received_on       date NOT NULL DEFAULT CURRENT_DATE,
  name              text NOT NULL,
  company           text NOT NULL DEFAULT '',
  phone             text NOT NULL DEFAULT '',
  email             text NOT NULL DEFAULT '',
  location          text NOT NULL DEFAULT '',
  source            text NOT NULL DEFAULT '',
  item              text NOT NULL DEFAULT '',      -- the product or custom item they want
  stage             text NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'contacted', 'follow_up', 'qualified', 'quote_sent', 'negotiation', 'won', 'lost')),
  next_follow_up    date NULL,
  rep_id            uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  rep_name          text NOT NULL DEFAULT '',      -- a rep named in the sheet who isn't in the OS
  comments          text NOT NULL DEFAULT '',
  lost_reason       text NOT NULL DEFAULT '',
  customer_id       uuid NULL REFERENCES customers(id) ON DELETE SET NULL,
  prospect_id       uuid NULL REFERENCES crm_prospects(id) ON DELETE SET NULL,
  external_key      text NULL UNIQUE,
  stage_changed_at  timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_leads_stage ON crm_leads (stage);
CREATE INDEX idx_crm_leads_rep ON crm_leads (rep_id);
CREATE INDEX idx_crm_leads_follow_up ON crm_leads (next_follow_up) WHERE next_follow_up IS NOT NULL;
CREATE INDEX idx_crm_leads_received ON crm_leads (received_on);
CREATE INDEX idx_crm_leads_customer ON crm_leads (customer_id);

CREATE TABLE crm_lead_notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      uuid NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'call', 'stage', 'visit', 'deal')),
  body         text NOT NULL DEFAULT '',
  from_stage   text NULL,
  to_stage     text NULL,
  by_employee  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_lead_notes_lead ON crm_lead_notes (lead_id, at DESC);

CREATE TABLE crm_deals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     uuid NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  invoice_id  uuid NOT NULL UNIQUE REFERENCES invoices(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'commission' CHECK (kind IN ('commission', 'kickback')),
  rep_id      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  rep_name    text NOT NULL DEFAULT '',
  core_team   text NOT NULL DEFAULT '',
  base_rate   numeric(5,2) NOT NULL,              -- the commission rate when the deal was linked
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'not_eligible')),
  paid_on     date NULL,
  paid_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  notes       text NOT NULL DEFAULT '',
  created_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_deals_lead ON crm_deals (lead_id);
CREATE INDEX idx_crm_deals_rep ON crm_deals (rep_id);

CREATE TABLE crm_referrals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_name      text NOT NULL,
  referrer_phone     text NOT NULL DEFAULT '',
  location           text NOT NULL DEFAULT '',
  lead_id            uuid NULL REFERENCES crm_leads(id) ON DELETE SET NULL,
  customer_referred  text NOT NULL DEFAULT '',
  invoice_id         uuid NULL REFERENCES invoices(id) ON DELETE SET NULL,
  deal_value         numeric(14,2) NULL,           -- only when the sale has no OS invoice
  rate               numeric(5,2) NOT NULL,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'not_eligible')),
  paid_on            date NULL,
  notes              text NOT NULL DEFAULT '',
  external_key       text NULL UNIQUE,
  created_by         uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crm_site_visits (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id        uuid NULL REFERENCES crm_leads(id) ON DELETE SET NULL,
  client         text NOT NULL,
  location       text NOT NULL DEFAULT '',
  scheduled_on   date NOT NULL,
  status         text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'visited', 'cancelled')),
  assessor_ids   uuid[] NOT NULL DEFAULT '{}',
  assessors_text text NOT NULL DEFAULT '',         -- names from the sheet that aren't OS employees
  findings       text NOT NULL DEFAULT '',
  external_key   text NULL UNIQUE,
  created_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_site_visits_date ON crm_site_visits (scheduled_on);

-- Permissions. New ones reach the catalogue and the administrator role
-- through bootstrap.js too, but existing roles are only ever created once,
-- so the sales-side roles get theirs here.
INSERT INTO permissions (key, "group", label) VALUES
  ('crm.read', 'Sales', 'View the CRM: leads, prospects, site visits'),
  ('crm.manage', 'Sales', 'Add and work leads, prospects and site visits'),
  ('crm.commission', 'Sales', 'See everyone''s commissions and mark them paid')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r
JOIN (VALUES
  ('administrator', 'crm.read'), ('administrator', 'crm.manage'), ('administrator', 'crm.commission'),
  ('executive', 'crm.read'), ('executive', 'crm.commission'),
  ('general_manager', 'crm.read'), ('general_manager', 'crm.manage'), ('general_manager', 'crm.commission'),
  ('marketing_manager', 'crm.read'), ('marketing_manager', 'crm.manage'),
  ('customer_service_manager', 'crm.read'), ('customer_service_manager', 'crm.manage'),
  ('finance_manager', 'crm.read'), ('finance_manager', 'crm.commission'),
  ('finance_hr_manager', 'crm.read'), ('finance_hr_manager', 'crm.commission')
) AS p(role_key, key) ON p.role_key = r.key
ON CONFLICT DO NOTHING;
