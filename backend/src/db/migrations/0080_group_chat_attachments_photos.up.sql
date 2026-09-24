-- Messages grow up (src/services/messages.service.js): group chats next to
-- one-to-one chats, files and photos in messages, and a profile photo for
-- every person and every group.
--
-- A conversation is either 'direct' (two people; direct_key is their two
-- ids, sorted, so there is only ever one per pair) or 'group'. Membership
-- carries the role (group admins can rename, change the photo and manage
-- members) and last_read_at, which replaces the per-message read flag for
-- counting what is unread — it works the same for two people or thirty.
--
-- Files live in Cloudflare R2 when it is configured (lib/storage.js), and
-- otherwise in stored_files below, so attachments and photos work either
-- way (lib/fileStore.js). A storage key starting 'db:' is a stored_files row.

CREATE TABLE stored_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type  text NOT NULL,
  size          integer NOT NULL,
  data          bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE employees ADD COLUMN photo_key text NULL;
ALTER TABLE employees ADD COLUMN photo_updated_at timestamptz NULL;

CREATE TABLE conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('direct', 'group')),
  name             text NOT NULL DEFAULT '',
  description      text NOT NULL DEFAULT '',
  photo_key        text NULL,
  photo_updated_at timestamptz NULL,
  direct_key       text NULL UNIQUE,
  created_by       uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_message_at  timestamptz NULL
);

CREATE TABLE conversation_members (
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  role             text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  joined_at        timestamptz NOT NULL DEFAULT now(),
  last_read_at     timestamptz NOT NULL DEFAULT now(),
  left_at          timestamptz NULL,
  PRIMARY KEY (conversation_id, employee_id)
);
CREATE INDEX idx_conversation_members_employee ON conversation_members (employee_id) WHERE left_at IS NULL;

-- Group messages have no single recipient; a message may be only files
-- (empty body); 'system' messages record group events (created, members
-- added or removed, renamed …) with their details in meta, so each viewer
-- reads them in their own language.
ALTER TABLE messages ADD COLUMN conversation_id uuid NULL REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE messages ALTER COLUMN to_id DROP NOT NULL;
ALTER TABLE messages ALTER COLUMN body SET DEFAULT '';
ALTER TABLE messages ADD COLUMN kind text NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'system'));
ALTER TABLE messages ADD COLUMN meta jsonb NULL;
CREATE INDEX idx_messages_conversation_at ON messages (conversation_id, at);

CREATE TABLE message_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_name     text NOT NULL,
  content_type  text NOT NULL,
  size          integer NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'file')),
  storage_key   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_message_attachments_message ON message_attachments (message_id);

-- Every existing one-to-one chat becomes a direct conversation, with what
-- each person had read carried over: they have read up to the last message
-- sent to them that was marked read.
INSERT INTO conversations (kind, direct_key, created_at, last_message_at)
SELECT 'direct', least(from_id::text, to_id::text) || '|' || greatest(from_id::text, to_id::text), min(at), max(at)
FROM messages GROUP BY least(from_id::text, to_id::text), greatest(from_id::text, to_id::text);

UPDATE messages m SET conversation_id = c.id FROM conversations c
WHERE c.direct_key = least(m.from_id::text, m.to_id::text) || '|' || greatest(m.from_id::text, m.to_id::text);

INSERT INTO conversation_members (conversation_id, employee_id, joined_at, last_read_at)
SELECT c.id, p.emp::uuid, c.created_at,
  coalesce((SELECT max(m.at) FROM messages m WHERE m.conversation_id = c.id AND m.to_id = p.emp::uuid AND m.read), c.created_at - interval '1 second')
FROM conversations c
CROSS JOIN LATERAL (VALUES (split_part(c.direct_key, '|', 1)), (split_part(c.direct_key, '|', 2))) AS p(emp)
WHERE c.kind = 'direct';
