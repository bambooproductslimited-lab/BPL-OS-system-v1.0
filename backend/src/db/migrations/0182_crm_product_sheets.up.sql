-- Products sent to a customer (crmProductSheets.service.js): the items a
-- rep picked from the catalogue, as they were when sent (name, price,
-- photo), behind a link the customer opens without signing in. Its views
-- are counted, and the rep is told the first time it is opened.
CREATE TABLE crm_product_sheets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token           text NOT NULL UNIQUE,
  lead_id         uuid NULL REFERENCES crm_leads(id) ON DELETE SET NULL,
  customer_id     uuid NULL REFERENCES customers(id) ON DELETE SET NULL,
  to_name         text NOT NULL DEFAULT '',
  to_phone        text NOT NULL DEFAULT '',
  items           jsonb NOT NULL DEFAULT '[]',
  note            text NOT NULL DEFAULT '',
  currency        text NOT NULL DEFAULT 'GHS',
  sent_by         uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  views           integer NOT NULL DEFAULT 0,
  first_viewed_at timestamptz NULL,
  last_viewed_at  timestamptz NULL,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_product_sheets_lead ON crm_product_sheets (lead_id, created_at DESC);
CREATE INDEX idx_crm_product_sheets_customer ON crm_product_sheets (customer_id, created_at DESC);
