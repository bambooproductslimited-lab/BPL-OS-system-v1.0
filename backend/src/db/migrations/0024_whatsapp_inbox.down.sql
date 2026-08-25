-- Best-effort revert — fails if any webhook-originated (created_by NULL)
-- rows exist, same caveat as any down migration that tightens a
-- constraint after real data may have relied on the looser one.
ALTER TABLE marketing_inbox_items ALTER COLUMN created_by SET NOT NULL;
DROP INDEX idx_marketing_inbox_channel_external;
ALTER TABLE marketing_inbox_items DROP COLUMN external_id;
