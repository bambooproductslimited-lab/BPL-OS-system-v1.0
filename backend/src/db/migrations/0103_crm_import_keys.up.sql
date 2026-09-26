-- A sale in the imported spreadsheet that belongs to a lead already in the
-- CRM (the same customer on the sheet's Leads tab) is added to that lead
-- rather than making a second one (services/crmImport.service.js). The
-- lead keeps its own import key, so the sale's key is kept here, and
-- importing the same workbook again still adds nothing twice.
CREATE TABLE crm_import_keys (
  external_key  text PRIMARY KEY,
  lead_id       uuid NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now()
);
