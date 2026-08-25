-- Support real inbound WhatsApp messages landing in the engagement inbox
-- automatically via webhook, rather than only ever being typed in by hand:
--
-- external_id lets a repeat webhook delivery (Meta retries undelivered
-- webhooks) update the same row instead of duplicating it, same pattern as
-- marketing_posts' external_id/source columns from the TikTok OAuth
-- migration.
--
-- created_by becomes nullable because a webhook-originated row has no
-- Bamboo OS user who typed it in — NULL here means "received
-- automatically", same meaning NULL already carries for marketing_posts
-- rows with source='synced'.
ALTER TABLE marketing_inbox_items ADD COLUMN external_id text NULL;
CREATE UNIQUE INDEX idx_marketing_inbox_channel_external ON marketing_inbox_items(channel_id, external_id) WHERE external_id IS NOT NULL;
ALTER TABLE marketing_inbox_items ALTER COLUMN created_by DROP NOT NULL;
