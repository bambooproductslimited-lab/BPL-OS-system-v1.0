DROP TABLE IF EXISTS marketing_audiences;
DROP TABLE IF EXISTS marketing_intel;
DROP TABLE IF EXISTS marketing_competitors;
DROP TABLE IF EXISTS marketing_assets;
DROP TABLE IF EXISTS marketing_brand;
DROP TABLE IF EXISTS marketing_promotion_uses;
DROP TABLE IF EXISTS marketing_promotions;
DROP TABLE IF EXISTS marketing_request_files;
DROP TABLE IF EXISTS marketing_request_comments;
DROP TABLE IF EXISTS marketing_requests;
DROP TABLE IF EXISTS marketing_spend;
DROP TABLE IF EXISTS marketing_event_tasks;
DROP TABLE IF EXISTS marketing_events;
DROP TABLE IF EXISTS marketing_budgets;
DROP INDEX IF EXISTS idx_crm_leads_campaign;
ALTER TABLE crm_leads DROP COLUMN IF EXISTS campaign_id;
DROP INDEX IF EXISTS idx_marketing_campaigns_code;
ALTER TABLE marketing_campaigns DROP COLUMN IF EXISTS objective, DROP COLUMN IF EXISTS audience, DROP COLUMN IF EXISTS key_message,
  DROP COLUMN IF EXISTS channels, DROP COLUMN IF EXISTS budget, DROP COLUMN IF EXISTS owner_id, DROP COLUMN IF EXISTS code,
  DROP COLUMN IF EXISTS target_leads, DROP COLUMN IF EXISTS target_revenue, DROP COLUMN IF EXISTS target_reach,
  DROP COLUMN IF EXISTS review, DROP COLUMN IF EXISTS updated_at;
UPDATE marketing_campaigns SET status = 'planned' WHERE status IN ('draft', 'paused');
UPDATE marketing_campaigns SET status = 'completed' WHERE status = 'cancelled';
ALTER TABLE marketing_campaigns DROP CONSTRAINT marketing_campaigns_status_check;
ALTER TABLE marketing_campaigns ADD CONSTRAINT marketing_campaigns_status_check CHECK (status IN ('planned', 'active', 'completed'));
