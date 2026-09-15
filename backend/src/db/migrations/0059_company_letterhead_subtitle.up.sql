-- A sister company's documents are headed by its own wordmark rather than
-- the group's logo — Poki bills tenants as "Poki Properties", under the
-- office that runs it, and an invoice carrying Bamboo Products' bamboo mark
-- would misstate who is charging them.
--
-- The subtitle is a general letterhead field rather than anything
-- Poki-specific, so the other companies already in this table can set one
-- without another migration.
ALTER TABLE companies ADD COLUMN letterhead_subtitle text NOT NULL DEFAULT '';

UPDATE companies
   SET legal_name = 'Poki Properties',
       letterhead_subtitle = 'The Office Of Sen-Lin Chou'
 WHERE code = 'PKI';
