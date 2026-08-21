DROP INDEX IF EXISTS idx_marketing_posts_channel_external;
ALTER TABLE marketing_posts DROP COLUMN IF EXISTS source;
ALTER TABLE marketing_posts DROP COLUMN IF EXISTS external_id;
DROP TABLE IF EXISTS marketing_oauth_tokens;
DROP TABLE IF EXISTS marketing_oauth_states;
