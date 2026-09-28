-- 1. The language each person reads (kiosk.service.js): the kiosk shows the
--    result of their tap — welcome, shift, the reminder to clock out — in
--    it. Many kiosk users have no OS account, so it lives on the employee;
--    NULL follows their account's own language (users.locale), if any.
ALTER TABLE employees ADD COLUMN language text NULL CHECK (language IN ('en', 'fr', 'zh'));

-- 2. A name from an imported spreadsheet ("Jennifer", "Mr. Frank") that
--    someone has said is this staff member (crm.service.js assignName), so
--    the next import matches it straight away (crmImport.service.js).
CREATE TABLE crm_name_aliases (
  name_key     text PRIMARY KEY,                    -- lower case, single spaces
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  created_by   uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
