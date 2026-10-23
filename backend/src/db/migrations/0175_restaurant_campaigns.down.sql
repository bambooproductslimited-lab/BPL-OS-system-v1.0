DROP TABLE IF EXISTS restaurant_campaign_sends;
DROP TABLE IF EXISTS restaurant_campaigns;
DROP INDEX IF EXISTS uq_restaurant_guests_unsubscribe;
ALTER TABLE restaurant_guests DROP COLUMN IF EXISTS unsubscribe_token, DROP COLUMN IF EXISTS marketing_at, DROP COLUMN IF EXISTS marketing,
  DROP COLUMN IF EXISTS birthday, DROP COLUMN IF EXISTS email;
