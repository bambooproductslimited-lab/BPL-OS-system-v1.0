ALTER TABLE employees DROP COLUMN last_seen_at;
ALTER TABLE conversation_members DROP COLUMN typing_at;
ALTER TABLE conversations DROP COLUMN updated_at;
DROP TABLE message_reactions;
DROP INDEX idx_messages_pinned;
ALTER TABLE messages DROP COLUMN reply_to, DROP COLUMN edited_at, DROP COLUMN deleted_at, DROP COLUMN forwarded,
  DROP COLUMN pinned_at, DROP COLUMN pinned_by, DROP COLUMN record, DROP COLUMN mentions;
