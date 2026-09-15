UPDATE companies SET legal_name = 'Poki' WHERE code = 'PKI';
ALTER TABLE companies DROP COLUMN IF EXISTS letterhead_subtitle;
