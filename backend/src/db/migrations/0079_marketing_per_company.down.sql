DELETE FROM marketing_channels WHERE company_id IS NOT NULL AND company_id <> (SELECT id FROM companies WHERE code = 'BPL');
DELETE FROM marketing_campaigns WHERE company_id IS NOT NULL AND company_id <> (SELECT id FROM companies WHERE code = 'BPL');
ALTER TABLE marketing_oauth_pending DROP COLUMN company_code;
ALTER TABLE marketing_oauth_states DROP COLUMN company_code;
DROP INDEX idx_marketing_campaigns_company;
ALTER TABLE marketing_campaigns DROP COLUMN company_id;
DROP INDEX idx_marketing_channels_company;
ALTER TABLE marketing_channels DROP COLUMN platform;
ALTER TABLE marketing_channels DROP COLUMN company_id;
