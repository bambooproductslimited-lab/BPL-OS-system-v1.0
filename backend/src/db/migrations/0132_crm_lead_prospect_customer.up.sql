-- Lead → Prospect → Customer, the way the sales team counts:
--   a lead is anyone who comes in (an enquiry, or a contact from a fair, an
--   event or a business list);
--   a prospect is a lead being worked on for real: qualified, quoted, or
--   agreeing terms (crm_leads.stage qualified, quote_sent, negotiation);
--   a customer is someone who has paid.
--
-- 1. The contact lists (crm_prospects) were kept apart from the leads, as
--    "prospects" to approach. They become leads at the New stage, keeping
--    the list's name as where they came from. The list rows stay, as the
--    record of what was imported; a contact already turned into a lead is
--    not added twice.
INSERT INTO crm_leads (received_on, name, company, phone, email, source, item, stage, comments, prospect_id, external_key, created_by, created_at)
SELECT p.created_at::date,
       coalesce(nullif(p.name, ''), nullif(p.company, ''), 'Unnamed contact'),
       CASE WHEN p.name <> '' THEN p.company ELSE '' END,
       p.phone, p.email,
       left(coalesce(nullif(p.list_name, ''), 'Contact list'), 40),
       left(p.interest, 200), 'new',
       concat_ws(' ',
         'From the contact list "' || coalesce(nullif(p.list_name, ''), 'Contact list') || '"' || CASE WHEN p.market = 'export' THEN ' (export market).' ELSE '.' END,
         CASE WHEN p.website <> '' THEN 'Website: ' || p.website || '.' END,
         nullif(p.notes, '')),
       p.id, p.external_key, p.created_by, p.created_at
FROM crm_prospects p
WHERE NOT EXISTS (SELECT 1 FROM crm_leads l WHERE l.prospect_id = p.id)
  AND (p.external_key IS NULL OR NOT EXISTS (SELECT 1 FROM crm_leads l WHERE l.external_key = p.external_key));

INSERT INTO crm_lead_notes (lead_id, kind, body, to_stage, at)
SELECT l.id, 'stage', 'Moved from the contact lists.', 'new', l.created_at
FROM crm_leads l JOIN crm_prospects p ON p.id = l.prospect_id
WHERE NOT EXISTS (SELECT 1 FROM crm_lead_notes n WHERE n.lead_id = l.id);

-- 2. A quotation sent makes the customer a prospect, and moves their leads
--    that haven't got that far to "Quote sent".
CREATE FUNCTION crm_quote_makes_prospect() RETURNS trigger AS $$
DECLARE l record;
BEGIN
  IF NEW.status NOT IN ('sent', 'viewed', 'accepted') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('sent', 'viewed', 'accepted') THEN RETURN NEW; END IF;
  UPDATE customers SET category = 'prospect' WHERE id = NEW.customer_id AND category = 'lead';
  FOR l IN SELECT id, stage FROM crm_leads
           WHERE customer_id = NEW.customer_id AND stage IN ('new', 'contacted', 'follow_up', 'qualified')
             AND received_on <= COALESCE(NEW.sent_at, NEW.created_at, now())::date LOOP
    UPDATE crm_leads SET stage = 'quote_sent', stage_changed_at = now(), updated_at = now() WHERE id = l.id;
    INSERT INTO crm_lead_notes (lead_id, kind, body, from_stage, to_stage) VALUES (l.id, 'stage', 'Quotation ' || NEW.quote_no || ' sent.', l.stage, 'quote_sent');
  END LOOP;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER quotations_make_prospect AFTER INSERT OR UPDATE OF status ON quotations
  FOR EACH ROW EXECUTE FUNCTION crm_quote_makes_prospect();

-- 3. The first payment on a sale makes them a customer: their profile says
--    Customer, and their open leads from before that sale are won.
CREATE FUNCTION crm_payment_makes_customer() RETURNS trigger AS $$
DECLARE inv record; l record;
BEGIN
  IF NEW.amount <= 0 THEN RETURN NEW; END IF;
  SELECT id, invoice_no, doc_kind, issued_at INTO inv FROM invoices WHERE id = NEW.invoice_id;
  IF inv.id IS NULL OR inv.doc_kind <> 'sale' THEN RETURN NEW; END IF;
  UPDATE customers SET category = 'active' WHERE id = NEW.customer_id AND category IN ('lead', 'prospect');
  FOR l IN SELECT id, stage FROM crm_leads
           WHERE stage IN ('new', 'contacted', 'follow_up', 'qualified', 'quote_sent', 'negotiation')
             AND ((customer_id = NEW.customer_id AND received_on <= inv.issued_at)
               OR id IN (SELECT lead_id FROM crm_deals WHERE invoice_id = inv.id)) LOOP
    UPDATE crm_leads SET stage = 'won', stage_changed_at = now(), updated_at = now() WHERE id = l.id;
    INSERT INTO crm_lead_notes (lead_id, kind, body, from_stage, to_stage) VALUES (l.id, 'stage', 'Paid ' || inv.invoice_no || ' — now a customer.', l.stage, 'won');
  END LOOP;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER payments_make_customer AFTER INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION crm_payment_makes_customer();

-- 4. Put what is already there right once: anyone who has paid for a sale is
--    a customer, and anyone quoted is at least a prospect.
UPDATE customers c SET category = 'active'
WHERE c.category IN ('lead', 'prospect')
  AND EXISTS (SELECT 1 FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.customer_id = c.id AND p.amount > 0 AND i.doc_kind = 'sale');
UPDATE customers c SET category = 'prospect'
WHERE c.category = 'lead'
  AND EXISTS (SELECT 1 FROM quotations q WHERE q.customer_id = c.id AND q.status IN ('sent', 'viewed', 'accepted'));
-- Open leads whose customer has since paid for a sale raised after the
-- lead came in are won, as the trigger above would have done.
WITH paid AS (
  SELECT l.id, l.stage,
         (SELECT i.invoice_no FROM payments p JOIN invoices i ON i.id = p.invoice_id
          WHERE p.amount > 0 AND i.doc_kind = 'sale' AND ((p.customer_id = l.customer_id AND i.issued_at >= l.received_on)
             OR i.id IN (SELECT invoice_id FROM crm_deals WHERE lead_id = l.id))
          ORDER BY p.date LIMIT 1) AS invoice_no
  FROM crm_leads l
  WHERE l.stage IN ('new', 'contacted', 'follow_up', 'qualified', 'quote_sent', 'negotiation')
), moved AS (
  UPDATE crm_leads l SET stage = 'won', stage_changed_at = now(), updated_at = now()
  FROM paid WHERE paid.id = l.id AND paid.invoice_no IS NOT NULL
  RETURNING l.id, paid.stage AS from_stage, paid.invoice_no
)
INSERT INTO crm_lead_notes (lead_id, kind, body, from_stage, to_stage)
SELECT id, 'stage', 'Paid ' || invoice_no || ' — now a customer.', from_stage, 'won' FROM moved;
