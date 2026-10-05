DELETE FROM role_permissions WHERE permission_key = 'crm.assign';
DELETE FROM permissions WHERE key = 'crm.assign';
DROP INDEX IF EXISTS idx_sales_orders_rep;
ALTER TABLE sales_orders DROP COLUMN IF EXISTS rep_id;
DROP TABLE IF EXISTS customer_merges;
DROP TABLE IF EXISTS crm_duplicate_suggestions;
DROP TABLE IF EXISTS crm_channel_state;
DROP TABLE IF EXISTS crm_messages;
DROP TABLE IF EXISTS crm_conversations;
DROP TABLE IF EXISTS customer_identities;
DROP INDEX IF EXISTS idx_customers_follow_up;
DROP INDEX IF EXISTS idx_customers_account_manager;
ALTER TABLE customers DROP COLUMN IF EXISTS created_at, DROP COLUMN IF EXISTS rep_assigned_at, DROP COLUMN IF EXISTS marketing_opt_out,
  DROP COLUMN IF EXISTS last_outbound_at, DROP COLUMN IF EXISTS last_inbound_at, DROP COLUMN IF EXISTS last_contact_at,
  DROP COLUMN IF EXISTS follow_up_note, DROP COLUMN IF EXISTS follow_up_on, DROP COLUMN IF EXISTS location, DROP COLUMN IF EXISTS origin_channel;
UPDATE customers SET source = 'manual' WHERE source = 'crm';
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_source_check;
ALTER TABLE customers ADD CONSTRAINT customers_source_check CHECK (source IN ('manual', 'square'));
