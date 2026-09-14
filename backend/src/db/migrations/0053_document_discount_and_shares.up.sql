-- documents.js's computeDocTotals(items, docDiscount, docTaxRate) has always
-- accepted a document-level discount/tax rate on top of per-line ones — the
-- create handlers already pass p.discount/p.taxRate through — but the
-- resulting VALUE was never persisted, only the computed discount_total/
-- tax_total. Without these, reopening a document can't show "10% off" as
-- anything but an opaque already-applied number. invoices also never had
-- notes/terms at all (quotations/estimates have had them since migration
-- 0008); adding them now for parity across all three document types.
ALTER TABLE quotations ADD COLUMN discount_value numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE quotations ADD COLUMN discount_type text NOT NULL DEFAULT 'fixed' CHECK (discount_type IN ('fixed', 'percent'));
ALTER TABLE quotations ADD COLUMN tax_rate numeric(6,3) NOT NULL DEFAULT 0;

ALTER TABLE estimates ADD COLUMN discount_value numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE estimates ADD COLUMN discount_type text NOT NULL DEFAULT 'fixed' CHECK (discount_type IN ('fixed', 'percent'));
ALTER TABLE estimates ADD COLUMN tax_rate numeric(6,3) NOT NULL DEFAULT 0;

ALTER TABLE invoices ADD COLUMN discount_value numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN discount_type text NOT NULL DEFAULT 'fixed' CHECK (discount_type IN ('fixed', 'percent'));
ALTER TABLE invoices ADD COLUMN tax_rate numeric(6,3) NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN notes text NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN terms text NOT NULL DEFAULT '';

-- A shareable, unauthenticated read-only link for a quotation/estimate/
-- invoice — Square's "Share link" option. expires_at NULL means "Never".
-- The token is the only thing standing between anyone-with-the-link and
-- the document, so it's a long random value, never a sequential id.
CREATE TABLE document_shares (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token          text NOT NULL UNIQUE,
  document_type  text NOT NULL CHECK (document_type IN ('quotation', 'estimate', 'invoice')),
  document_id    uuid NOT NULL,
  expires_at     timestamptz NULL,
  created_by     uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_document_shares_document ON document_shares(document_type, document_id);
