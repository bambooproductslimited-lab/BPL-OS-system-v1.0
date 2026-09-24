-- The social & campaign tracker for each company, not just Bamboo Products
-- Limited (src/services/marketingChannels.js). Star Bar Restaurant and
-- Bamboo Garden get their own channels, campaigns, posts, follower history
-- and inbox; each company's Facebook, TikTok, YouTube … connects to its own
-- account.
--
-- A channel now belongs to a company and says which platform it is on.
-- Posts, follower snapshots and inbox items belong to their channel, so
-- they follow. Bamboo Products' existing channels and campaigns become its
-- own; their keys ('facebook' …) stay as they are, since the stored OAuth
-- tokens are keyed by them. Other companies' channels are '<code>-<platform>'.
ALTER TABLE marketing_channels ADD COLUMN company_id uuid NULL REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE marketing_channels ADD COLUMN platform text NULL;
UPDATE marketing_channels SET platform = key, company_id = (SELECT id FROM companies WHERE code = 'BPL');
CREATE INDEX idx_marketing_channels_company ON marketing_channels (company_id);

ALTER TABLE marketing_campaigns ADD COLUMN company_id uuid NULL REFERENCES companies(id) ON DELETE CASCADE;
UPDATE marketing_campaigns SET company_id = (SELECT id FROM companies WHERE code = 'BPL');
CREATE INDEX idx_marketing_campaigns_company ON marketing_campaigns (company_id);

-- A connection in progress remembers which company's account it is for
-- (Meta's flow connects a company's Facebook Page and its Instagram at once).
ALTER TABLE marketing_oauth_states ADD COLUMN company_code text NULL;
ALTER TABLE marketing_oauth_pending ADD COLUMN company_code text NULL;

-- The restaurants' channels (added again by bootstrap.js on deploy if a
-- restaurant company is created later).
INSERT INTO marketing_channels (key, name, kind, platform, company_id)
SELECT lower(c.code) || '-' || v.platform, v.name, v.kind, v.platform, c.id
FROM companies c
CROSS JOIN (VALUES
  ('facebook', 'Facebook', 'social'), ('instagram', 'Instagram', 'social'), ('tiktok', 'TikTok', 'social'),
  ('youtube', 'YouTube', 'social'), ('whatsapp', 'WhatsApp Business', 'social'), ('website', 'Website', 'web'),
  ('googlebusiness', 'Google Business Profile', 'directory'), ('tripadvisor', 'TripAdvisor', 'directory')
) AS v(platform, name, kind)
WHERE c.code IN ('SBR', 'BGN')
ON CONFLICT (key) DO NOTHING;
