DROP TRIGGER IF EXISTS payments_make_customer ON payments;
DROP FUNCTION IF EXISTS crm_payment_makes_customer();
DROP TRIGGER IF EXISTS quotations_make_prospect ON quotations;
DROP FUNCTION IF EXISTS crm_quote_makes_prospect();
-- The contacts moved from the lists and never worked on go back to being
-- list rows only (the list rows were kept).
DELETE FROM crm_leads l
WHERE l.prospect_id IS NOT NULL AND l.stage = 'new'
  AND NOT EXISTS (SELECT 1 FROM crm_lead_notes n WHERE n.lead_id = l.id AND n.body <> 'Moved from the contact lists.')
  AND NOT EXISTS (SELECT 1 FROM crm_deals d WHERE d.lead_id = l.id);
