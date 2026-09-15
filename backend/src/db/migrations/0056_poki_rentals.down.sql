DROP INDEX IF EXISTS idx_invoices_doc_kind;
DROP INDEX IF EXISTS idx_invoices_poki_lease;
ALTER TABLE invoices DROP COLUMN IF EXISTS period_end;
ALTER TABLE invoices DROP COLUMN IF EXISTS period_start;
ALTER TABLE invoices DROP COLUMN IF EXISTS poki_lease_id;
ALTER TABLE invoices DROP COLUMN IF EXISTS doc_kind;

DROP TABLE IF EXISTS poki_agreement_templates;
DROP TABLE IF EXISTS poki_maintenance_requests;
DROP TABLE IF EXISTS poki_master_bills;
DROP TABLE IF EXISTS poki_meter_readings;
DROP TABLE IF EXISTS poki_meters;
DROP TABLE IF EXISTS poki_leases;
DROP TABLE IF EXISTS poki_tenants;
DROP TABLE IF EXISTS poki_units;
DROP TABLE IF EXISTS poki_properties;

DROP INDEX IF EXISTS idx_invoices_company;
DROP INDEX IF EXISTS idx_estimates_company;
DROP INDEX IF EXISTS idx_quotations_company;
DROP INDEX IF EXISTS idx_customers_company;
ALTER TABLE invoices   DROP COLUMN IF EXISTS company_id;
ALTER TABLE estimates  DROP COLUMN IF EXISTS company_id;
ALTER TABLE quotations DROP COLUMN IF EXISTS company_id;
ALTER TABLE customers  DROP COLUMN IF EXISTS company_id;

ALTER TABLE companies DROP COLUMN IF EXISTS invoice_footer;
ALTER TABLE companies DROP COLUMN IF EXISTS payment_details;
ALTER TABLE companies DROP COLUMN IF EXISTS tax_id;
ALTER TABLE companies DROP COLUMN IF EXISTS email;
ALTER TABLE companies DROP COLUMN IF EXISTS phone;
ALTER TABLE companies DROP COLUMN IF EXISTS ghana_post_gps;
ALTER TABLE companies DROP COLUMN IF EXISTS address;
ALTER TABLE companies DROP COLUMN IF EXISTS legal_name;

UPDATE settings SET commercial = commercial #- '{numbering,lease}' WHERE id = 1;
DELETE FROM companies WHERE code = 'PKI';
